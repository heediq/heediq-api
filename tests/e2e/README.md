# E2E smoke (`tests/e2e/`)

D-147: each user-facing flow ships a scripted happy-path smoke that runs against the **real deployed
stack** (real auth token, real API, real WS + SQS/workers). These run **deliberately** — after
deploying to an environment, before calling it done — **not** as part of the local pre-PR gate (D-030
layer table). They exist to catch deploy/config/wiring/permission gaps that mocked unit + integration
tests structurally cannot.

Standalone Node scripts (Node ≥ 22 for global `fetch`/`WebSocket`) — no test framework, per D-147's
"lightweight Node script is acceptable for headless API+WS/queue flows."

## `full-loop-smoke.mjs` — the whole MVP critical path
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

Then it deletes the ephemeral Context (conversation/messages cascade) and the Source.

**Scope notes**
- **Text ingest, not audio.** The audio path (`POST /sources/:id/jobs` → GPU Whisper worker) is
  deliberately out — real transcription needs GPU Spot capacity and is too slow/flaky for a repeatable
  smoke. Add a separate, manually-run audio smoke when that path needs deploy-level proof.
- **`bypassLedgerGating: true`** on the chat turn (D-149): review reconciliation (D-148) can leave the
  fresh Context's Decision Ledger with `needs_review` entries, which would otherwise `409 LEDGER_GATED`.
  This smoke exercises the loop wiring, not the gate (the gate has unit coverage).

## `../../../heediq-chat/tests/e2e/chat-smoke.mjs` — Context chat happy path
The first D-147 instance (lives in heediq-chat). Creates a Context → conversation → posts a message →
asserts the streamed reply. `full-loop-smoke.mjs` is the superset for the capture→review→chat path;
`chat-smoke.mjs` stays as the focused chat-only smoke.

## Run
```sh
API_BASE=https://<api-id>.execute-api.eu-west-1.amazonaws.com \
WS_URL=wss://<ws-id>.execute-api.eu-west-1.amazonaws.com/ws \
ID_TOKEN=<cognito ID token> \
pnpm run e2e:full-loop
```
- **`ID_TOKEN`** must be the Cognito **ID** token (carries `custom:orgId`/`custom:role`), not the
  access token. Alternatively point `TOKEN_FILE` at a file containing it. Get one by signing a dev user
  in via `USER_PASSWORD_AUTH` and taking the `IdToken`.
- Optional: `CLASSIFY_TIMEOUT_MS` (default 120000), `CHAT_TIMEOUT_MS` (default 90000).
- Exit code: `0` pass · `1` assertion fail · `2` fatal/config error.

> **Still owed (D-147 backlog):** a shared token-provisioning helper (both smokes currently take a
> hand-provisioned `ID_TOKEN`) and CI wiring to run these post-deploy automatically.
