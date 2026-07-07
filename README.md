# heediq-api

REST API Lambda: Hono on Node.js 22, deployed via `heediq-infra` ApiStack (D-034).

## Purpose

All Heediq REST endpoints in a single Lambda function. Handles auth, Source CRUD (D-068 — any ingested unit: audio, PDF, doc, image, pasted text, not just recordings), job enqueueing, presigned S3 uploads, and serving summaries. Enforces org-level tenant isolation and D-060 model-access control at the API boundary.

## Key Files

- `src/app.ts` — Hono app: CORS, auth middleware wiring, `/api/v1/` route registration
- `src/lambda.ts` — Lambda handler (`hono/aws-lambda`)
- `src/config.ts` — env var config (all injected by CDK at deploy, D-038)
- `src/middleware/auth.ts` — JWKS-based Cognito JWT validation (jose), sets `userId/orgId/email/role` on context (D-041). `userId` is read from the `custom:accountId` claim, never `sub` (D-099) — `sub` can be repointed to a different Cognito user by `AdminLinkProviderForUser` during account linking, so it's not a stable identity key.
- `src/middleware/request-id.ts` — correlation ID middleware (D-085): reads `X-Request-Id` from the caller or generates a UUID, sets it on context, and echoes it back as a response header
- `src/lib/errors.ts` — `apiError()` / `ok()` response helpers with consistent envelope (D-033)
- `src/lib/dynamo.ts` — DynamoDB Document Client singleton
- `src/routes/me.ts` — `GET /api/v1/me`
- `src/routes/sources.ts` — Source CRUD + job enqueue + summary fetch (D-068)
- `src/routes/upload.ts` — `POST /api/v1/upload/presign` (S3 presigned URL)
- `src/routes/auth.ts` — unauthenticated `/api/v1/auth` sub-app: `lookup-email` + D-087/D-089 cross-provider linking (`link/request-otp`, `link/verify-otp`, `link/confirm`)
- `src/lib/cognito.ts` — Cognito Identity Provider SDK wrapper (`SignUp`, `ConfirmSignUp`, `ResendConfirmationCode`, `AdminSetUserPassword`, `AdminLinkProviderForUser`, `AdminDeleteUser`, `AdminCreateUser`, `ListUsers`) used by `routes/auth.ts` and the trigger handlers below
- `src/lib/accountIdentity.ts` — shared identity-resolution helpers (D-099): `resolveAccountIdBySub` (deterministic `heediq-cognito-identities` lookup), `linkIdentity` (pins a `sub → accountId` mapping), `resolveAccountIdByEmail` (fallback-only self-heal via the `by-email` GSI, provisional until pinned). Used by every auth handler/route below instead of each duplicating its own lookup.
- `src/handlers/auth-provision.ts` — Cognito PreTokenGeneration trigger (D-077/D-099): resolves `accountId` via `heediq-cognito-identities` first (deterministic); falls back to the `by-email` self-heal, pinning the mapping via `linkIdentity` for future logins; on a genuinely first login, generates a new app-owned `accountId` (`randomUUID`, decoupled from `sub`) and writes org + user + identity mapping + initial auth-method + audit entries in one `Promise.all`. Always emits `custom:accountId`/`custom:orgId`/`custom:role` claims. No `email_verified` gate (D-090) — provisioning is unconditional on first login for any method, since D-089 makes ownership of the email Heediq's own responsibility, not an IdP-asserted claim.
- `src/routes/auth-methods.ts` — authenticated `GET /api/v1/auth/methods` (D-091): lists the caller's active sign-in methods from `heediq-user-auth-methods`, scoped to their own `userId` (the `custom:accountId`-derived value, D-099)
- `src/handlers/auth-trigger-pre-signup.ts` — Cognito PreSignUp trigger (`PreSignUp_ExternalProvider` only): links a new federated login onto a matching native account by email
- `src/handlers/auth-trigger-post-confirmation.ts` — Cognito PostConfirmation trigger (`PostConfirmation_ConfirmSignUp` only): records the auth method + audit event only when an existing `accountId` can be positively resolved (identities table, then email self-heal). Fires before `auth-provision.ts`, so a genuinely new signup has no `accountId` yet (D-099) — rather than guess one, it skips the write entirely and defers the initial auth-method/audit entry to `auth-provision.ts`'s first-login branch.
- `src/handlers/auth-trigger-post-authentication.ts` — Cognito PostAuthentication trigger (`PostAuthentication_Authentication` only): resolves the canonical `accountId` the same way `auth-provision.ts` will moments later (identities table first, D-099), records the auth method for the login just completed, self-heals by pinning an unresolved `sub` via `linkIdentity`, and auto-links a federated login to an existing native account with the same email if not yet linked

## Data Flow

```
Client  →  API Gateway HTTP API  →  Lambda (Hono)
                                         │
                requestIdMiddleware: correlation ID on context + response header (D-085)
                                         │
                        authMiddleware: validate Cognito JWT (JWKS)
                                         │
                 /me  →  DynamoDB (users + orgs tables)
             /sources  →  DynamoDB (sources table) + SQS (transcription queue)
       /sources/:id/jobs  →  D-060 check + DynamoDB (jobs table) + SQS enqueue
   /upload/presign  →  S3 presigned PUT URL (client uploads directly to S3)
```

## Contracts

All request/response shapes defined in `@heediq/shared` (D-033). API prefix: `/api/v1/` (D-042).

**Endpoints:**
```
GET    /api/v1/me
GET    /api/v1/sources?limit=20&cursor=<b64>
POST   /api/v1/sources                { title, durationSecs? }
GET    /api/v1/sources/:id
PATCH  /api/v1/sources/:id            { title? }
DELETE /api/v1/sources/:id
POST   /api/v1/sources/:id/jobs       { sourceId, model: 'small'|'large-v3' }
GET    /api/v1/sources/:id/summary
POST   /api/v1/upload/presign         { sourceId, contentType, fileSizeBytes }

POST   /api/v1/auth/lookup-email      { email } -> { exists, passwordSet }              (unauthenticated)
POST   /api/v1/auth/link/request-otp  { email }  -> { sent: true }                       (unauthenticated, D-087)
POST   /api/v1/auth/link/verify-otp   { email, code } -> { verified: true }              (unauthenticated, D-089)
POST   /api/v1/auth/link/confirm      { email, newPassword } -> { passwordSet: true }    (unauthenticated, D-087/D-089)
GET    /api/v1/auth/methods           -> { methods: [{ provider, linkedAt }] }             (authenticated, D-091)
```

**D-087/D-089 linking flow:** `request-otp` calls Cognito `SignUp` (creating a native `UNCONFIRMED` user so Cognito emails its own verification code) or falls back to `ResendConfirmationCode` if the native user already exists mid-flow. If that existing native user is stuck `CONFIRMED` but never had a password set (abandoned between the `verify-otp` and `confirm` screens — D-096, since Cognito permanently refuses to resend a code to a `CONFIRMED` user), it self-heals by deleting that orphaned user (`AdminDeleteUser`) and re-running `SignUp` so a fresh code goes out; a `CONFIRMED` user that *does* have a password set (`passwordSet: true` in `heediq-users`) is a real linked account and is left untouched. It always returns `{ sent: true }` regardless of outcome to avoid account-existence enumeration. `verify-otp` calls `ConfirmSignUp` on its own, before any password is collected (D-089) — any failure (including `NotAuthorizedException` from an already-confirmed/non-`UNCONFIRMED` account) is rejected as an invalid code, never bypassed; the code is consumed here and is never sent again. `confirm` is called only after `verify-otp` has already succeeded — it first rejects with `WEAK_PASSWORD` if `@heediq/shared`'s `isPasswordPolicyCompliant` fails (no Cognito round trip, D-094), then calls `AdminSetUserPassword` (an `InvalidPasswordException` here also returns `WEAK_PASSWORD` — the authoritative backstop for policy checks the shared function can't see, e.g. password-history reuse), then `AdminLinkProviderForUser` for every external-provider user found for that email, and records the auth method once linking succeeds.

**D-097/D-098 OTP rate limiting:** `request-otp` and `verify-otp` are unauthenticated, so both are
also guarded by an app-level limiter (`src/lib/rateLimit.ts`) on top of the infra-level API Gateway
throttling (`heediq-infra/README.md`): a DynamoDB fixed-window counter checks both the email being
targeted (5 requests / 15 min) and the caller's source IP, resolved via `getClientIp` — a try/catch
wrapper around `hono/aws-lambda`'s `getConnInfo`, since that helper throws outside a real Lambda
invocation (10 requests / 60 sec). Either key tripping returns the same `RATE_LIMITED` error shape
Cognito's own `LimitExceededException` would produce, before Cognito is ever called — preserving the
non-disclosure guarantee from D-078. The window boundary is baked into the partition key itself
(`bucketStart = floor(now / windowSeconds) * windowSeconds`); the `expiresAt` TTL attribute is
storage cleanup only, not correctness (DynamoDB TTL deletion isn't immediately timed). A prod-only
WAF rate-based rule is scaffolded in `heediq-infra` but shipped disabled until a marketing campaign
is planned (D-098) — see `heediq-infra/README.md`'s ApiStack section.

**D-099 accountId identity (Cognito ↔ DynamoDB contract):** `heediq-cognito-identities` (pk = `sub`,
attribute = `accountId`) is the deterministic map from every Cognito identity (native or federated) a
person has ever logged in with onto one app-owned `accountId`. Every JWT issued by Cognito carries
`custom:accountId` (set only by `auth-provision.ts`), and every part of this API — `middleware/auth.ts`
included — treats that claim, not `sub`, as the identity key. The `by-email` GSI on `heediq-users` is
now a fallback-only self-heal path for identities that predate this table or arrive freshly repointed
by `AdminLinkProviderForUser`; any resolution via email immediately pins a `sub → accountId` row so
future logins take the deterministic path.

**D-091 active methods:** `heediq-user-auth-methods` is the authoritative source of truth for which
methods are active on an account — `GET /auth/methods` is a straight `Query` on `pk = USER#<userId>`,
`begins_with(sk, METHOD#)`, scoped to the caller's own `userId` (cross-org/account isolation).
`heediq-web`'s Settings screen renders this list read-only; there is no unlink/remove endpoint yet.

**D-060 access control (job enqueue):** free-tier orgs may only request `model: 'small'`; `large-v3` returns 403 for free orgs.

**`POST /api/v1/sources/:id/jobs` body includes `sourceId`:** the handler enqueues against the `:id` URL param, not `body.sourceId` — the schema field exists for symmetry with the SQS message shape but isn't cross-checked against the URL param. Do not rely on it to target a different source than the URL.

**`DELETE /api/v1/sources/:id` is a soft-delete:** sets `status='failed'` and writes `deletedAt` — does not remove the DynamoDB item. Hard delete is not implemented at MVP.

**Response envelope:** `{ ok: true, data: T }` | `{ ok: false, error: { code, message, details? } }`

**API version prefix (D-088):** `/api/v1/` is written in exactly one place — the two `app.route()`
calls in `src/app.ts`. Route modules (`routes/*.ts`) never include the prefix themselves; they mount
at their bare resource path (`auth.post('/lookup-email', ...)`) and `app.ts` supplies `/api/v1`. Any
new router follows the same pattern — mount it in `app.ts`, don't hardcode the prefix inside it.

## Dependencies

- Upstream: `heediq-infra` (Lambda + API Gateway + DynamoDB + S3 + SQS must exist before deploy, D-050)
- Upstream: `@heediq/shared` (Zod schemas + types, D-033) — pinned to `^0.8.0` (D-085/D-093 `createLogger` structured logger, mandatory per D-093; `passwordPolicy.ts`'s `isPasswordPolicyCompliant` is consumed in `routes/auth.ts`'s `/link/confirm`, D-094)
- Downstream: `heediq-worker-transcription` (reads SQS messages enqueued here). `config.ts` also reads `SUMMARIZATION_QUEUE_URL`, but no route currently sends to it — the text-upload → summarization-queue direct path isn't wired up yet.
- Shared surfaces: `heediq-sources`, `heediq-jobs` DynamoDB tables
- Upstream (auth): `heediq-infra`'s `UserAuthMethodsTable`/`AuthAuditLogTable` (D-087) and the Cognito User Pool triggers wired to the 3 `auth-trigger-*.ts` handlers — see `heediq-infra/README.md`
- Upstream (auth): `heediq-infra`'s `heediq-rate-limits` table (D-097) backing `src/lib/rateLimit.ts`

## Testing

```bash
pnpm run test          # 87 unit tests (auth routes + auth methods + auth triggers + sources + app routing + rate limiting)
pnpm run typecheck     # tsc --noEmit
pnpm run test:pre-pr   # typecheck + test (run before opening a PR)
pnpm run dev           # local dev server on :3000 (tsx watch)
```

`pnpm run dev` calls `requireEnv()` in `config.ts` at cold start and crashes immediately if any of
these 13 vars are unset — all real AWS resources deployed by `heediq-infra`, no local fakes:
`COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `SOURCES_TABLE_NAME`, `ORGS_TABLE_NAME`,
`USERS_TABLE_NAME`, `JOBS_TABLE_NAME`, `WS_CONNECTIONS_TABLE_NAME`, `USER_AUTH_METHODS_TABLE_NAME`,
`AUTH_AUDIT_LOG_TABLE_NAME`, `RATE_LIMITS_TABLE_NAME`, `COGNITO_IDENTITIES_TABLE_NAME`,
`AUDIO_BUCKET_NAME`, `TRANSCRIPTION_QUEUE_URL`, `SUMMARIZATION_QUEUE_URL`. Pull the actual values
from the deployed `dev` account (SSM params / CDK stack outputs, see `heediq-infra/README.md`) into
a local `.env` and export before running `dev`.

Integration tests (Vitest + DynamoDB Local) — to be added once the integration suite is set up.

## Gotchas & Constraints

- **Route-prefix tests must use the real `app` (D-088):** `src/__tests__/app-routing.test.ts`
  imports the actual `app` from `app.ts` and asserts on the full `/api/v1/...` path. The other route
  test files (`lookup-email.test.ts`, `auth-link.test.ts`, `sources.test.ts`) mount their router at
  bare `/` in isolation — fine for testing handler logic, but it means they'd stay green even if the
  route were mounted at the wrong prefix in `app.ts`. That gap is exactly how a production 404
  shipped (`heediq-web` calling `/auth/lookup-email` against a backend only serving
  `/api/v1/auth/lookup-email`). Any new prefix-sensitive assertion belongs in `app-routing.test.ts`.
- **`@heediq/shared` install:** CI uses `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to pull from GitHub Packages. Local dev requires a GitHub PAT with `read:packages` scope set as `NODE_AUTH_TOKEN` — add `//npm.pkg.github.com/:_authToken=<PAT>` to `~/.npmrc` or export the var before running `pnpm install`.
- **JWKS caching:** `createRemoteJWKSet()` is called once at cold start; jose handles key rotation automatically.
- **Structured logging (D-085/D-093):** `app.ts` and `routes/sources.ts` log via `@heediq/shared`'s `createLogger('heediq-api')` — structured JSON with `requestId` (from `request-id.ts` middleware) and `sourceId` where available. Raw `console.log`/`console.error` is disallowed (D-093) — always go through the logger. Default log level is `info` in every environment; `debug` is opt-in via the `LOG_LEVEL` env var, read at runtime with no redeploy needed. The logger's own PII denylist redacts transcript/email/token-like fields; never pass raw transcript text as log metadata. X-Ray active tracing is enabled on the Lambda (`heediq-infra` `ApiStack`, D-085) for request-level tracing alongside these logs.
- **`WS_CONNECTIONS_TABLE_NAME` env var:** required by `config.ts` and injected by CDK, but the WebSocket connect/disconnect route handlers are not yet implemented in this Lambda. The table reference is pre-wired here ready for the WS handler code (D-050). Without this var the Lambda will crash at cold start.
- **D-060:** Model access is enforced by fetching the org's `plan` field from DynamoDB on every enqueue request — not cached. Acceptable at MVP scale; add caching if DynamoDB latency becomes a concern.
- **Source list pagination:** cursor is a base64url-encoded DynamoDB `LastEvaluatedKey`. Members only see their own sources (FilterExpression); admins see all org sources.
- **`labels: []` set explicitly on create:** the `Source` object built in `POST /sources` is written directly via `PutCommand`, bypassing `SourceSchema.parse()`, so the schema's `labels` default (`[]`) is set explicitly in code to match what a read-back `.parse()` would produce.
- **Deploy:** CI builds via `pnpm run bundle` (esbuild) and runs `aws lambda update-function-code` per environment, gated by the D-070/D-071 org-level `vars.AWS_REGION` / `vars.DEPLOY_ROLE_ARN`. See `heediq-infra/README.md` §"Initial Setup" for CDK-bootstrap prerequisites (Lambda + API Gateway must be deployed by CDK before this repo's CI can update function code).
- **The 3 `auth-trigger-*.ts` handlers are separate bundled Lambda entry points**, not part of the main API Lambda — each has its own `bundle:auth-trigger-*` esbuild script and its own deploy step in `deploy.yml` per environment, same pattern as `auth-provision.ts`.
- **`custom:accountId` (D-099) required a full Cognito User Pool replacement:** adding a custom attribute changes the User Pool's `Schema`, which CloudFormation can only apply via full resource replacement — this destroys all existing users in whichever environment it's deployed to. Confirmed and accepted for dev; requires explicit sign-off before staging/prod (existing users would need to re-sign-up).
