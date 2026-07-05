# heediq-api

REST API Lambda: Hono on Node.js 22, deployed via `heediq-infra` ApiStack (D-034).

## Purpose

All Heediq REST endpoints in a single Lambda function. Handles auth, Source CRUD (D-068 — any ingested unit: audio, PDF, doc, image, pasted text, not just recordings), job enqueueing, presigned S3 uploads, and serving summaries. Enforces org-level tenant isolation and D-060 model-access control at the API boundary.

## Key Files

- `src/app.ts` — Hono app: CORS, auth middleware wiring, `/api/v1/` route registration
- `src/lambda.ts` — Lambda handler (`hono/aws-lambda`)
- `src/config.ts` — env var config (all injected by CDK at deploy, D-038)
- `src/middleware/auth.ts` — JWKS-based Cognito JWT validation (jose), sets `userId/orgId/email/role` on context (D-041)
- `src/lib/errors.ts` — `apiError()` / `ok()` response helpers with consistent envelope (D-033)
- `src/lib/dynamo.ts` — DynamoDB Document Client singleton
- `src/routes/me.ts` — `GET /api/v1/me`
- `src/routes/sources.ts` — Source CRUD + job enqueue + summary fetch (D-068)
- `src/routes/upload.ts` — `POST /api/v1/upload/presign` (S3 presigned URL)
- `src/routes/auth.ts` — unauthenticated `/api/v1/auth` sub-app: `lookup-email` + D-087 cross-provider linking (`link/request-otp`, `link/confirm`)
- `src/lib/cognito.ts` — Cognito Identity Provider SDK wrapper (`SignUp`, `ConfirmSignUp`, `ResendConfirmationCode`, `AdminSetUserPassword`, `AdminLinkProviderForUser`, `AdminCreateUser`, `ListUsers`) used by `routes/auth.ts` and the trigger handlers below
- `src/handlers/auth-provision.ts` — Cognito PreTokenGeneration trigger (D-077): idempotent get-or-create of org+user, injects `custom:orgId`/`custom:role` claims. Resolves the existing row **by email first, falling back to `sub`** (`resolveExistingUser`) — a post-linking re-login presents the destination/native user's `sub`, not the original federated `sub`, so an email-first lookup avoids provisioning a duplicate org. No `email_verified` gate (D-090) — provisioning is unconditional on first login for any method, since D-089 makes ownership of the email Heediq's own responsibility, not an IdP-asserted claim.
- `src/routes/auth-methods.ts` — authenticated `GET /api/v1/auth/methods` (D-091): lists the caller's active sign-in methods from `heediq-user-auth-methods`, scoped to their own `userId`
- `src/handlers/auth-trigger-pre-signup.ts` — Cognito PreSignUp trigger (`PreSignUp_ExternalProvider` only): links a new federated login onto a matching native account by email
- `src/handlers/auth-trigger-post-confirmation.ts` — Cognito PostConfirmation trigger (`PostConfirmation_ConfirmSignUp` only): records the auth method + audit event; does NOT write the main `users` row (that's `auth-provision.ts`'s job, lazily at first login)
- `src/handlers/auth-trigger-post-authentication.ts` — Cognito PostAuthentication trigger (`PostAuthentication_Authentication` only): records the auth method for the login just completed and auto-links a federated login to an existing native account with the same email if not yet linked

## Data Flow

```
Client  →  API Gateway HTTP API  →  Lambda (Hono)
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
POST   /api/v1/auth/link/confirm      { email, code, newPassword } -> { passwordSet: true } (unauthenticated, D-087)
GET    /api/v1/auth/methods           -> { methods: [{ provider, linkedAt }] }             (authenticated, D-091)
```

**D-087 linking flow:** `request-otp` calls Cognito `SignUp` (creating a native `UNCONFIRMED` user so Cognito emails its own verification code) or falls back to `ResendConfirmationCode` if the native user already exists mid-flow; it always returns `{ sent: true }` regardless of outcome to avoid account-existence enumeration. `confirm` calls `ConfirmSignUp`, `AdminSetUserPassword`, then `AdminLinkProviderForUser` for every external-provider user found for that email, and records the auth method once linking succeeds.

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
- Upstream: `@heediq/shared` (Zod schemas + types, D-033) — pinned to `^0.2.0` (D-068 Source rename)
- Downstream: `heediq-worker-transcription` (reads SQS messages enqueued here), `heediq-worker-summarization` (reads SQS from text-upload path)
- Shared surfaces: `heediq-sources`, `heediq-jobs` DynamoDB tables
- Upstream (auth): `heediq-infra`'s `UserAuthMethodsTable`/`AuthAuditLogTable` (D-087) and the Cognito User Pool triggers wired to the 3 `auth-trigger-*.ts` handlers — see `heediq-infra/README.md`

## Testing

```bash
pnpm run test          # 63 unit tests (auth routes + auth methods + auth triggers + sources + app routing)
pnpm run typecheck     # tsc --noEmit
pnpm run test:pre-pr   # typecheck + test (run before opening a PR)
pnpm run dev           # local dev server on :3000 (tsx watch)
```

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
- **`WS_CONNECTIONS_TABLE_NAME` env var:** required by `config.ts` and injected by CDK, but the WebSocket connect/disconnect route handlers are not yet implemented in this Lambda. The table reference is pre-wired here ready for the WS handler code (D-050). Without this var the Lambda will crash at cold start.
- **D-060:** Model access is enforced by fetching the org's `plan` field from DynamoDB on every enqueue request — not cached. Acceptable at MVP scale; add caching if DynamoDB latency becomes a concern.
- **Source list pagination:** cursor is a base64url-encoded DynamoDB `LastEvaluatedKey`. Members only see their own sources (FilterExpression); admins see all org sources.
- **`labels: []` set explicitly on create:** the `Source` object built in `POST /sources` is written directly via `PutCommand`, bypassing `SourceSchema.parse()`, so the schema's `labels` default (`[]`) is set explicitly in code to match what a read-back `.parse()` would produce.
- **Deploy:** CI builds via `pnpm run bundle` (esbuild) and runs `aws lambda update-function-code` per environment, gated by the D-070/D-071 org-level `vars.AWS_REGION` / `vars.DEPLOY_ROLE_ARN`. See `heediq-infra/README.md` §"Initial Setup" for CDK-bootstrap prerequisites (Lambda + API Gateway must be deployed by CDK before this repo's CI can update function code).
- **The 3 `auth-trigger-*.ts` handlers are separate bundled Lambda entry points**, not part of the main API Lambda — each has its own `bundle:auth-trigger-*` esbuild script and its own deploy step in `deploy.yml` per environment, same pattern as `auth-provision.ts`.
- **D-087 deliberately does not replicate emotix's `post-confirmation` behavior of upserting the main `users` row.** heediq's `auth-provision.ts` PreTokenGeneration trigger already owns lazy user provisioning at first login; `auth-trigger-post-confirmation.ts` only records the auth method + audit event.
