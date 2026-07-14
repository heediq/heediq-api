# heediq-api

REST API Lambda: Hono on Node.js 22, deployed via `heediq-infra` ApiStack (D-034).

## Purpose

All Heediq REST endpoints in a single Lambda function. Handles auth, Source CRUD (D-068 — any ingested unit: audio, PDF, doc, image, pasted text, not just recordings), job enqueueing, presigned S3 uploads, and serving summaries. Enforces org-level tenant isolation and D-060 model-access control at the API boundary.

## Key Files

- `src/app.ts` — Hono app: CORS, auth middleware wiring, `/api/v1/` route registration
- `src/lambda.ts` — Lambda handler (`hono/aws-lambda`)
- `src/config.ts` — env var config (all injected by CDK at deploy, D-038)
- `src/middleware/auth.ts` — JWKS-based Cognito JWT validation (jose), sets `userId/orgId/email/role/permissions` on context (D-041). `userId` is read from the `custom:accountId` claim, never `sub` (D-099) — `sub` can be repointed to a different Cognito user by `AdminLinkProviderForUser` during account linking, so it's not a stable identity key. `permissions` is parsed from the `custom:permissions` JWT claim (JSON-stringified `Permission[]`, D-105) — a missing/malformed/unknown-value claim is rejected with `401 UNAUTHORIZED`.
- `src/middleware/rbac.ts` — `requirePermission(permission)` (D-105): route-level middleware that checks `c.get('permissions').includes(permission)`, a pure in-token check with no DynamoDB read; returns `403 FORBIDDEN` naming the missing permission.
- `src/lib/rbac.ts` — `ensureOrgRbacSeeded`, `ensureUserRoleAssignment`, `resolveEffectivePermissions` (D-102/D-105): takes an explicit `RbacTables` parameter object rather than importing `config.ts`, since `auth-provision.ts` (its only caller) is a separate minimal-env Lambda that would crash importing the full API's `config.ts`. `resolveEffectivePermissions` unions permissions from every role reached directly or via group membership.
- `src/middleware/request-id.ts` — correlation ID middleware (D-085): reads `X-Request-Id` from the caller or generates a UUID, sets it on context, and echoes it back as a response header
- `src/lib/errors.ts` — `apiError()` / `ok()` response helpers with consistent envelope (D-033)
- `src/lib/dynamo.ts` — DynamoDB Document Client singleton
- `src/routes/me.ts` — `GET /api/v1/me`; response includes `effectivePermissions` (D-102/D-105), the server-resolved permission set already parsed by `authMiddleware` from the `custom:permissions` JWT claim — the only source of authority `heediq-web`'s `usePermissions`/`<Can>` are allowed to read
- `src/routes/users.ts` — `GET /api/v1/users` — org-scoped user list (D-102 Phase 4), used by the role/group assignment screen; read-open to any authenticated org member, same posture as `GET /roles`/`GET /groups`
- `src/routes/sources.ts` — Source CRUD + job enqueue + summary fetch (D-068)
- `src/routes/upload.ts` — `POST /api/v1/upload/presign` (S3 presigned URL)
- `src/routes/auth.ts` — unauthenticated `/api/v1/auth` sub-app: `lookup-email` + D-087/D-089 cross-provider linking (`link/request-otp`, `link/verify-otp`, `link/confirm`)
- `src/lib/cognito.ts` — Cognito Identity Provider SDK wrapper (`SignUp`, `ConfirmSignUp`, `ResendConfirmationCode`, `AdminSetUserPassword`, `AdminLinkProviderForUser`, `AdminDeleteUser`, `AdminCreateUser`, `ListUsers`) used by `routes/auth.ts` and the trigger handlers below
- `src/lib/accountIdentity.ts` — shared identity-resolution helpers (D-099): `resolveAccountIdBySub` (deterministic `heediq-cognito-identities` lookup), `linkIdentity` (pins a `sub → accountId` mapping), `resolveAccountIdByEmail` (fallback-only self-heal via the `by-email` GSI, provisional until pinned). Used by every auth handler/route below instead of each duplicating its own lookup.
- `src/handlers/auth-provision.ts` — Cognito PreTokenGeneration trigger (D-077/D-099): resolves `accountId` via `heediq-cognito-identities` first (deterministic); falls back to the `by-email` self-heal, pinning the mapping via `linkIdentity` for future logins; on a genuinely first login, generates a new app-owned `accountId` (`randomUUID`, decoupled from `sub`), seeds the org's RBAC roles via `ensureOrgRbacSeeded` (D-102), assigns the new admin user their role via `ensureUserRoleAssignment`, and writes org + user + identity mapping + initial auth-method + audit entries in one `Promise.all`. Always emits `custom:accountId`/`custom:orgId`/`custom:role`/`custom:permissions` claims — `custom:permissions` is `resolveEffectivePermissions()`'s output, JSON-stringified, baked into the token at issuance (D-105) rather than checked per-request against DynamoDB. No `email_verified` gate (D-090) — provisioning is unconditional on first login for any method, since D-089 makes ownership of the email Heediq's own responsibility, not an IdP-asserted claim.
- `src/routes/auth-methods.ts` — authenticated `GET /api/v1/auth/methods` (D-091): lists the caller's active sign-in methods from `heediq-user-auth-methods`, scoped to their own `userId` (the `custom:accountId`-derived value, D-099)
- `src/handlers/auth-trigger-pre-signup.ts` — Cognito PreSignUp trigger (`PreSignUp_ExternalProvider` only): links a new federated login onto a matching native account by email
- `src/handlers/auth-trigger-post-confirmation.ts` — Cognito PostConfirmation trigger (`PostConfirmation_ConfirmSignUp` only): records the auth method + audit event only when an existing `accountId` can be positively resolved (identities table, then email self-heal). Fires before `auth-provision.ts`, so a genuinely new signup has no `accountId` yet (D-099) — rather than guess one, it skips the write entirely and defers the initial auth-method/audit entry to `auth-provision.ts`'s first-login branch.
- `src/handlers/auth-trigger-post-authentication.ts` — Cognito PostAuthentication trigger (`PostAuthentication_Authentication` only): resolves the canonical `accountId` the same way `auth-provision.ts` will moments later (identities table first, D-099), records the auth method for the login just completed, self-heals by pinning an unresolved `sub` via `linkIdentity`, and auto-links a federated login to an existing native account with the same email if not yet linked
- `src/lib/audit.ts` — `writeAuditEvent()` (D-102): calls `@heediq/shared`'s `buildAuditLogEntry()` then writes the entry via `PutCommand` against `config.dynamo.auditLogTable`; logs only ids/resourceType/action, never `before`/`after` payload bodies (D-093). `auditWriter(c)` (D-107) wraps it — route handlers call `auditWriter(c)({ resourceType, action, before?, after? })` and it fills in `orgId`/`actorUserId`/`actorEmail`/`actorRole` from the verified `AuthContext`, so call sites only spell out what's resource-specific.
- `src/routes/roles.ts` — Role CRUD (D-102): `GET/POST /api/v1/roles`, `GET/PATCH/DELETE /api/v1/roles/:id`; writes gated by `requirePermission('org:manage-roles')` (D-105); `DELETE` returns 409 for system roles (`isSystemRole: true`)
- `src/routes/groups.ts` — Group CRUD (D-102): `GET/POST /api/v1/groups`, `GET/PATCH/DELETE /api/v1/groups/:id`; writes gated by `requirePermission('org:manage-roles')` (D-105); validates every `roleIds[]` entry exists in the org (`BatchGetCommand`) before create/update
- `src/routes/role-assignments.ts` — Direct role/group assignment (D-102): `GET/POST /api/v1/users/:userId/role-assignments`, `DELETE /api/v1/users/:userId/role-assignments/role/:roleId` and `.../group/:groupId`; writes gated by `requirePermission('org:manage-roles')` (D-105); validates the target `roleId`/`groupId` exists in-org before assigning
- `src/routes/audit-log.ts` — `GET /api/v1/org/audit-log` (D-102 Phase 5): cursor-paginated read path over `heediq-audit-log`, gated by `requirePermission('audit:read')`; filterable by `from`/`to`, `action`, `resourceType`, and `actorUserId` (routes to the `by-user` GSI, re-asserting `orgId` via `FilterExpression` as cross-org defense-in-depth)

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
GET    /api/v1/me                     -> { user, org, effectivePermissions }                (D-102/D-105)
GET    /api/v1/users                  -> { users: User[] }  (org-scoped, D-102 Phase 4)
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

GET    /api/v1/roles                                                                       (D-102)
POST   /api/v1/roles                  { name, permissions[] }                              (D-102/D-105, requires org:manage-roles)
GET    /api/v1/roles/:id                                                                    (D-102)
PATCH  /api/v1/roles/:id              { name?, permissions? }                               (D-102/D-105, requires org:manage-roles)
DELETE /api/v1/roles/:id                                                                    (D-102/D-105, requires org:manage-roles; 409 if isSystemRole)

GET    /api/v1/groups                                                                        (D-102)
POST   /api/v1/groups                 { name, roleIds[] }                                    (D-102/D-105, requires org:manage-roles)
GET    /api/v1/groups/:id                                                                    (D-102)
PATCH  /api/v1/groups/:id             { name?, roleIds? }                                     (D-102/D-105, requires org:manage-roles)
DELETE /api/v1/groups/:id                                                                     (D-102/D-105, requires org:manage-roles)

GET    /api/v1/users/:userId/role-assignments                                                (D-102)
POST   /api/v1/users/:userId/role-assignments  { assignmentType: 'role', roleId } | { assignmentType: 'group', groupId }  (D-102/D-105, requires org:manage-roles)
DELETE /api/v1/users/:userId/role-assignments/role/:roleId                                    (D-102/D-105, requires org:manage-roles)
DELETE /api/v1/users/:userId/role-assignments/group/:groupId                                  (D-102/D-105, requires org:manage-roles)

GET    /api/v1/org/audit-log?limit=20&cursor=<b64>&from=<iso>&to=<iso>&action=<str>&resourceType=<str>&actorUserId=<str>   (D-102 Phase 5, requires audit:read)
```

**D-102/D-105 RBAC & audit trail:** Roles, Groups, and direct/group-mediated Role Assignments are the
building blocks of D-102's permission model (effective permissions = union of every role reached
directly or via group membership; no deny rules — see `@heediq/shared`'s `permissions.ts`). All write
endpoints above are gated by `requirePermission('org:manage-roles')` (`src/middleware/rbac.ts`), a
pure in-token check against the `permissions` array parsed from the `custom:permissions` JWT claim —
no DynamoDB read per request. Permissions are computed once, at token issuance, by
`resolveEffectivePermissions()` in `auth-provision.ts` (D-105 supersedes D-102's original
`rbacVersion`/staleness-check design; see `DECISIONS.md`). `groups.ts` validates every `roleIds[]`
entry exists in the org via `BatchGetCommand` before create/update; `role-assignments.ts` validates
the target `roleId`/`groupId` exists in-org via `GetCommand` before writing an assignment. `roles.ts`'s
`DELETE` refuses to remove a system role (`isSystemRole: true`, e.g. `admin`/`member`) with
`409 CONFLICT`. Every write (create/update/delete on roles, groups, and assignments) writes an audit
entry via `auditWriter(c)` (D-107, wraps `writeAuditEvent()` — see `src/lib/audit.ts` above and the
Gotchas section below), which also stamps the actor's org role (`actorRole`) on every entry.

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
- Upstream: `@heediq/shared` (Zod schemas + types, D-033) — pinned to `^0.11.0` (D-085/D-093 `createLogger` structured logger, mandatory per D-093; `passwordPolicy.ts`'s `isPasswordPolicyCompliant` is consumed in `routes/auth.ts`'s `/link/confirm`, D-094; D-102 adds the 5 RBAC request schemas and `buildAuditLogEntry()`, consumed by `routes/roles.ts`/`groups.ts`/`role-assignments.ts` and `lib/audit.ts`)
- Downstream: `heediq-worker-transcription` (reads SQS messages enqueued here). `config.ts` also reads `SUMMARIZATION_QUEUE_URL`, but no route currently sends to it — the text-upload → summarization-queue direct path isn't wired up yet.
- Shared surfaces: `heediq-sources`, `heediq-jobs` DynamoDB tables
- Upstream (auth): `heediq-infra`'s `UserAuthMethodsTable`/`AuthAuditLogTable` (D-087) and the Cognito User Pool triggers wired to the 3 `auth-trigger-*.ts` handlers — see `heediq-infra/README.md`
- Upstream (auth): `heediq-infra`'s `heediq-rate-limits` table (D-097) backing `src/lib/rateLimit.ts`

## Testing

```bash
pnpm run test          # 167 unit tests (auth routes + auth methods + auth triggers + sources + app routing + rate limiting + roles + groups + role-assignments + rbac + rbac-middleware + me + users)
pnpm run typecheck     # tsc --noEmit
pnpm run test:pre-pr   # typecheck + test (run before opening a PR)
pnpm run dev           # local dev server on :3000 (tsx watch)
```

`pnpm run dev` calls `requireEnv()` in `config.ts` at cold start and crashes immediately if any of
these 18 vars are unset — all real AWS resources deployed by `heediq-infra`, no local fakes:
`COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `SOURCES_TABLE_NAME`, `ORGS_TABLE_NAME`,
`USERS_TABLE_NAME`, `JOBS_TABLE_NAME`, `WS_CONNECTIONS_TABLE_NAME`, `USER_AUTH_METHODS_TABLE_NAME`,
`AUTH_AUDIT_LOG_TABLE_NAME`, `RATE_LIMITS_TABLE_NAME`, `COGNITO_IDENTITIES_TABLE_NAME`,
`AUDIO_BUCKET_NAME`, `TRANSCRIPTION_QUEUE_URL`, `SUMMARIZATION_QUEUE_URL`, `ROLES_TABLE_NAME`,
`GROUPS_TABLE_NAME`, `ROLE_ASSIGNMENTS_TABLE_NAME`, `AUDIT_LOG_TABLE_NAME`. Pull the actual values
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
- **D-102 Phase 5 audit-log read path (`routes/audit-log.ts`):** `GET /org/audit-log` queries the base table (`pk = ORG#<orgId>`) by default, or the `by-user` GSI when `actorUserId` is given — the GSI query always adds `orgId = :orgId` to the `FilterExpression` too, as explicit cross-org defense-in-depth even though a user belongs to exactly one org today. The Lambda's IAM grant on this table is `Query` + write only — `GetItem`/`Scan` remain blocked (`heediq-infra` `api-stack.ts`), preserving the "no full-table read" posture from Phase 2.
- **D-105 permission staleness is bounded by token lifetime, not instant:** since `custom:permissions` is baked into the JWT at issuance rather than checked per-request against DynamoDB, a permission change (role edit, reassignment) only takes effect for a given user on their next token refresh — not immediately. This is a deliberate tradeoff (see `DECISIONS.md` D-105) in exchange for zero added DynamoDB reads on the request hot path.
