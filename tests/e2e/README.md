# E2E suite (`tests/e2e/`)

**D-156**: Heediq's E2E is a **single full real-backend suite** — real Cognito auth, real REST API +
WebSocket, real SQS/workers, real data create+teardown. It runs at **two moments only**:

- **Promote-to-staging gate** — automatically on push to `main` (the develop→main promotion), against
  the live **dev** stack, *before* `deploy-staging` (heediq-api `.github/workflows/deploy.yml`, job
  `e2e`). At promotion, `main` HEAD == what already runs on dev, so the dev stack is the proving ground.
- **Locally, on demand** — run it by hand against any deployed stack when you want end-to-end proof.

It does **not** run per-PR and **not** on the dev deploy (that was D-155's dropped mocked tier). This
absorbs the old D-147 "scripted smoke per feature" scripts — they are that suite.

Standalone Node scripts (Node ≥ 22 for global `fetch`/`WebSocket`) — no test framework, per D-147's
"lightweight Node script is acceptable for headless API+WS/queue flows."

## `lib/auth.mjs` — shared token provisioning
Every script needs a Cognito **ID** token (it carries `custom:orgId`/`custom:role`/`custom:accountId`;
the access token does not). `resolveIdToken()`:
- **Override** — `ID_TOKEN=<token>` or `TOKEN_FILE=/path` (back-compat, for a hand-provisioned token).
- **Provision** — else signs a seeded dev test user in via Cognito `USER_PASSWORD_AUTH` (ROPC) and takes
  the `IdToken`. Needs `COGNITO_CLIENT_ID` + `TEST_USER_EMAIL` + `TEST_USER_PASSWORD` (and
  `AWS_REGION`/`COGNITO_REGION`, default `eu-west-1`). It's a raw public Cognito call — **no AWS creds**.

The test user must already exist, be **CONFIRMED**, and have a **permanent** password; the app client
must have `USER_PASSWORD_AUTH` enabled. Provisioning deliberately does not create users or answer
`NEW_PASSWORD_REQUIRED` (that needs admin creds — a one-off setup script, not the per-run path).

## `full-loop-smoke.mjs` — the whole MVP critical path (gate default)
Proves the **capture → classify/extract → review → file-into-Context → chat** loop end to end on one
deploy — the front half plus the handoff into chat that `chat-smoke.mjs` (heediq-chat) does not cover:

1. `POST /sources` → create the Source shell
2. `POST /sources/:id/text` → ingest text (D-150 path, **skips transcription**) → enqueues classify+extract
3. wait for `classification_ready` over the WS (polls `GET /items` as a fallback)
4. `GET /sources/:id/items` → assert ≥ 1 ExtractedItem was produced
5. `POST /contexts` → an ephemeral Context to file into
6. `POST /sources/:id/review` `{ contextId, kept: [all itemIds] }` → files the items
7. `GET /sources/:id/items` → assert the kept items now carry `status:'kept'` + the `contextId`
8. `POST /conversations` + `POST /conversations/:id/messages` → assert `chat_delta` stream + `chat_complete`

Then it deletes the ephemeral Context (conversation/messages cascade) and the Source. This is the
**deterministic** path (no GPU), so it's what the promote-to-staging gate runs (`pnpm run e2e`).

`bypassLedgerGating: true` on the chat turn (D-149): review reconciliation (D-148) can leave the fresh
Context's Decision Ledger with `needs_review` entries, which would otherwise `409 LEDGER_GATED`. This
smoke exercises the loop wiring, not the gate (the gate has unit coverage).

## `audio-smoke.mjs` — the audio / transcription path (opt-in)
The one leg `full-loop-smoke.mjs` skips: **presign → S3 PUT → `POST /:id/jobs` → GPU Whisper worker →
summarization**. It synthesizes a ~1s tone WAV in-process (no committed binary fixture), uploads it,
enqueues a `small`-model job, and waits for the pipeline to reach a terminal `done`/`ready`.

**Opt-in, not part of the gate** — it depends on EC2 GPU Spot capacity coming up, so it's slow and
capacity-flaky. It asserts the pipeline *ran end to end*; it does **not** assert transcript wording or
item counts (a tone carries no words — those are logged best-effort). Run it on demand when the audio
path itself needs deploy-level proof. Timeout: `TRANSCRIBE_TIMEOUT_MS` (default 600000).

## `../../../heediq-chat/tests/e2e/chat-smoke.mjs` — Context chat happy path
The first D-147 instance (lives in heediq-chat). Creates a Context → conversation → posts a message →
asserts the streamed reply. `full-loop-smoke.mjs` is the superset for the capture→review→chat path;
`chat-smoke.mjs` stays as the focused chat-only smoke.

## Run locally
```sh
API_BASE=https://<api-id>.execute-api.eu-west-1.amazonaws.com \
WS_URL=wss://<ws-id>.execute-api.eu-west-1.amazonaws.com/ws \
COGNITO_CLIENT_ID=<app client id> \
TEST_USER_EMAIL=<seeded dev user> TEST_USER_PASSWORD=<password> \
pnpm run e2e          # full-loop (gate default). Or: ID_TOKEN=<token> to skip provisioning.

pnpm run e2e:audio    # opt-in GPU audio path
```
- `pnpm run e2e` === `pnpm run e2e:full-loop`.
- Optional: `CLASSIFY_TIMEOUT_MS` (default 120000), `CHAT_TIMEOUT_MS` (default 90000).
- Exit code: `0` pass · `1` assertion fail · `2` fatal/config error.

## In CI (promote-to-staging gate)
`.github/workflows/deploy.yml` job `e2e` (on `main` only): reads `API_BASE`/`WS_URL`/`COGNITO_CLIENT_ID`
from the **dev** account's SSM (`/heediq/api/endpoint-url`, `/heediq/api/ws-endpoint-url`,
`/heediq/api/cognito-client-id`) and provisions the token from `E2E_TEST_USER_EMAIL` /
`E2E_TEST_USER_PASSWORD` secrets. `deploy-staging` `needs: [build, e2e]`, so a red E2E blocks staging
(and thus prod). The audio smoke is not wired here — it stays a deliberate manual run.
