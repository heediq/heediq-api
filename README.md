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
- `docker-compose.integration.yml` — starts `amazon/dynamodb-local` (in-memory, shared DB) for integration tests
- `scripts/integration/create-tables.ts` — bootstraps all tables + GSIs against DynamoDB Local, mirroring `heediq-infra/lib/foundation/tables.ts`; skips tables that already exist
- `tests/integration/seed.ts` — shared integration seed helpers (`seedOrg`, `seedUser`, `seedIdentity`, `seedRoles`, `seedCustomRole`, `seedGroup`, `seedRoleAssignment`, `seedFullOrg`)
- `tests/integration/setup-env.ts` — Vitest `setupFiles` entry: sets `DYNAMODB_ENDPOINT` + placeholder values for the other `config.ts` env vars
- `src/routes/me.ts` — `GET /api/v1/me`; response includes `effectivePermissions` (D-102/D-105), the server-resolved permission set already parsed by `authMiddleware` from the `custom:permissions` JWT claim — the only source of authority `heediq-web`'s `usePermissions`/`<Can>` are allowed to read
- `src/routes/users.ts` — `GET /api/v1/users` — org-scoped user list (D-102 Phase 4), used by the role/group assignment screen; read-open to any authenticated org member, same posture as `GET /roles`/`GET /groups`
- `src/routes/sources.ts` — Source CRUD + job enqueue + summary fetch (D-068) + `POST /:id/review` (D-143/D-144): files approved extracted items into a Context
- `src/routes/contexts.ts` — Context Library CRUD + tree (D-143/D-144): list/tree/create/get/patch/delete over `heediq-contexts`, keyed by the `by-scope` GSI (`scopeKey` = `U#<userId>`\|`G#<groupId>`\|`O#<orgId>`, `SK = domainCreatedAt`). `canAccessContext(c, item)` is the shared visibility gate (personal = owner-only, group = live-membership-checked against `heediq-role-assignments`, org = any org member) — also imported by `sources.ts`'s review route to gate against the target context
- `src/routes/upload.ts` — `POST /api/v1/upload/presign` (S3 presigned URL)
- `src/routes/auth.ts` — unauthenticated `/api/v1/auth` sub-app: `lookup-email` + D-087/D-089 cross-provider linking (`link/request-otp`, `link/verify-otp`, `link/confirm`)
- `src/lib/cognito.ts` — Cognito Identity Provider SDK wrapper (`SignUp`, `ConfirmSignUp`, `ResendConfirmationCode`, `AdminSetUserPassword`, `AdminLinkProviderForUser`, `AdminDeleteUser`, `AdminCreateUser`, `ListUsers`) used by `routes/auth.ts` and the trigger handlers below
- `src/lib/accountIdentity.ts` — shared identity-resolution helpers (D-099): `resolveAccountIdBySub` (deterministic `heediq-cognito-identities` lookup), `linkIdentity` (pins a `sub → accountId` mapping), `resolveAccountIdByEmail` (fallback-only self-heal via the `by-email` GSI, provisional until pinned). Used by every auth handler/route below instead of each duplicating its own lookup.
- `src/handlers/auth-provision.ts` — Cognito PreTokenGeneration trigger (D-077/D-099): resolves `accountId` via `heediq-cognito-identities` first (deterministic); falls back to the `by-email` self-heal, pinning the mapping via `linkIdentity` for future logins; on a genuinely first login, generates a new app-owned `accountId` (`randomUUID`, decoupled from `sub`), seeds the org's RBAC roles via `ensureOrgRbacSeeded` (D-102), assigns the new admin user their role via `ensureUserRoleAssignment`, and writes org + user + identity mapping + initial auth-method + audit entries in one `Promise.all`. Always emits `custom:accountId`/`custom:orgId`/`custom:role`/`custom:permissions` claims — `custom:permissions` is `resolveEffectivePermissions()`'s output, JSON-stringified, baked into the token at issuance (D-105) rather than checked per-request against DynamoDB. No `email_verified` gate (D-090) — provisioning is unconditional on first login for any method, since D-089 makes ownership of the email Heediq's own responsibility, not an IdP-asserted claim.
- `src/routes/auth-methods.ts` — authenticated `GET /api/v1/auth/methods` (D-091): lists the caller's active sign-in methods from `heediq-user-auth-methods`, scoped to their own `userId` (the `custom:accountId`-derived value, D-099)
- `src/routes/settings.ts` — authenticated `POST /api/v1/settings/link/add-provider` (D-083): finishes the proactive Settings-linking round trip started by `heediq-web`'s `SettingsLinkCallbackPage` (which completes a fresh Hosted-UI OAuth exchange and extracts `{providerName, providerUserId}` from the returned ID token), calling `AdminLinkProviderForUser` to attach that federated identity to the caller's own native Cognito user. Self-service (links the caller's own account only) — not gated by `requirePermission`, same exemption as `me.ts`/`auth-methods.ts` (no RBAC permission exists for a self-scoped "manage my own identity" action, D-107; documented inline in the route's code comment)
- `src/handlers/auth-trigger-pre-signup.ts` — Cognito PreSignUp trigger (`PreSignUp_ExternalProvider` only): links a new federated login onto a matching native account by email
- `src/handlers/auth-trigger-post-confirmation.ts` — Cognito PostConfirmation trigger (`PostConfirmation_ConfirmSignUp` only): records the auth method + audit event only for a federated (Google/Microsoft) confirmation whose `accountId` can be positively resolved (identities table, then email self-heal). A native (email/password) confirmation never writes here — verifying the OTP only proves email ownership, not that a password exists yet; that write belongs to `routes/auth.ts`'s `recordAuthMethodAndAudit`, called from `/link/confirm` only after `AdminSetUserPassword` succeeds. (Previously this trigger wrote `METHOD#COGNITO` immediately on OTP verification whenever the email already matched an existing account, so `GET /auth/methods` could report email/password as linked with no password actually set if the linking flow was abandoned mid-way.) Fires before `auth-provision.ts`, so a genuinely new signup has no `accountId` yet (D-099) — rather than guess one, it skips the write entirely and defers the initial auth-method/audit entry to `auth-provision.ts`'s first-login branch.
- `src/handlers/auth-trigger-post-authentication.ts` — Cognito PostAuthentication trigger (`PostAuthentication_Authentication` only): resolves the canonical `accountId` the same way `auth-provision.ts` will moments later (identities table first, D-099), records the auth method for the login just completed, self-heals by pinning an unresolved `sub` via `linkIdentity`, and auto-links a federated login to an existing native account with the same email if not yet linked
- `src/lib/audit.ts` — `writeAuditEvent()` (D-102): calls `@heediq/shared`'s `buildAuditLogEntry()` then writes the entry via `PutCommand` against `config.dynamo.auditLogTable`; logs only ids/resourceType/action, never `before`/`after` payload bodies (D-093). `auditWriter(c)` (D-107) wraps it — route handlers call `auditWriter(c)({ resourceType, action, effect?, before?, after? })` and it fills in `orgId`/`actorUserId`/`actorEmail`/`actorRole` from the verified `AuthContext`, so call sites only spell out what's resource-specific. `effect` defaults to `'permitted'` (schema default, D-114); `requirePermission` is the only caller that ever passes `'denied'`.
- `src/middleware/rbac.ts` — `requirePermission(permission)` (D-102/D-105/D-114): pure in-token check against `permissions` from `AuthContext`, no DynamoDB read on the request path. On denial, writes a `resourceType: 'permission'`, `effect: 'denied'` audit entry via `auditWriter(c)` before returning 403 — a write failure here is logged and swallowed, never turned into a 500.
- `src/routes/roles.ts` — Role CRUD (D-102): `GET/POST /api/v1/roles`, `GET/PATCH/DELETE /api/v1/roles/:id`; writes gated by `requirePermission('org:manage-roles')` (D-105); `DELETE` returns 409 for system roles (`isSystemRole: true`)
- `src/routes/groups.ts` — Group CRUD (D-102): `GET/POST /api/v1/groups`, `GET/PATCH/DELETE /api/v1/groups/:id`; writes gated by `requirePermission('org:manage-roles')` (D-105); validates every `roleIds[]` entry exists in the org (`BatchGetCommand`) before create/update
- `src/routes/role-assignments.ts` — Direct role/group assignment (D-102): `GET/POST /api/v1/users/:userId/role-assignments`, `DELETE /api/v1/users/:userId/role-assignments/role/:roleId` and `.../group/:groupId`; writes gated by `requirePermission('org:manage-roles')` (D-105); validates the target `roleId`/`groupId` exists in-org before assigning
- `src/routes/audit-log.ts` — `GET /api/v1/org/audit-log` (D-102 Phase 5): cursor-paginated read path over `heediq-audit-log`, gated by `requirePermission('audit:read')`; filterable by `from`/`to`, `action`, `resourceType`, and `actorUserId` (routes to the `by-user` GSI, re-asserting `orgId` via `FilterExpression` as cross-org defense-in-depth)
- `src/handlers/ws-connect.ts` — WebSocket `$connect`/`$disconnect`/`$default` handler (D-061, generalized D-109): validates the JWT (passed as `?token=`, not a header) on connect and writes a `heediq-ws-connections` row keyed by `connectionId` with `userId`/`orgId`/`broadcastKey`; deletes the row on disconnect
- `src/handlers/ws-pusher.ts` — DDB Streams (`MODIFY`) consumer on `heediq-jobs` (D-061, generalized D-109): builds a `job_status` event via `@heediq/shared`'s `buildWsEvent()` and pushes it at org scope via `wsPush.ts`
- `src/handlers/classification-pusher.ts` — DDB Streams (`MODIFY`) consumer on `heediq-sources`, filtered (in infra) to rows entering `classification='pending_review'` (D-130/D-133): builds a `classification_ready` event (the Source's persisted `proposedClassification` + `sourceId`) via `buildWsEvent()` and pushes it at org scope via `wsPush.ts`. Same stream→pusher mechanism as `ws-pusher.ts`; the ingest worker never pushes WS itself
- `src/lib/wsPush.ts` — shared real-time push library (D-109): `pushToUser`/`pushToOrg`/`pushBroadcast`, any future feature's entry point for pushing a `WsEventEnvelope` without a DDB-Streams round trip; queries the matching GSI, POSTs via `ApiGatewayManagementApiClient`, self-heals by deleting a connection row on `GoneException`

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
 /sources/:id/review  →  canAccessContext gate + DynamoDB (extracted-items + contexts tables)
            /contexts  →  DynamoDB (contexts table, by-scope GSI) + canAccessContext gate
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
POST   /api/v1/sources/:id/review     { contextId, kept: string[] }  -> { keptCount, discardedCount }  (D-143/D-144, requires sources:update)
POST   /api/v1/upload/presign         { sourceId, contentType, fileSizeBytes }

GET    /api/v1/contexts?domain=<str>                                                        (D-143/D-144)
GET    /api/v1/contexts/tree                                                                  (D-143/D-144)
POST   /api/v1/contexts               { name, domain, visibility: 'personal'|'group'|'org', groupId?, parentContextId? }  (requires context:create)
GET    /api/v1/contexts/:id                                                                   (D-143/D-144)
PATCH  /api/v1/contexts/:id           { name?, visibility?, groupId?, parentContextId? }       (requires context:update)
DELETE /api/v1/contexts/:id                                                                    (requires context:delete; 409 if it has children)

POST   /api/v1/auth/lookup-email      { email } -> { exists, passwordSet }              (unauthenticated)
POST   /api/v1/auth/link/request-otp  { email }  -> { sent: true }                       (unauthenticated, D-087)
POST   /api/v1/auth/link/verify-otp   { email, code } -> { verified: true }              (unauthenticated, D-089)
POST   /api/v1/auth/link/confirm      { email, newPassword } -> { passwordSet: true }    (unauthenticated, D-087/D-089)
GET    /api/v1/auth/methods           -> { methods: [{ provider, linkedAt }] }             (authenticated, D-091)
POST   /api/v1/settings/link/add-provider  { provider, providerUserId } -> { linked: true } (authenticated, self-service, D-083)

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
`requirePermission` (D-114) is also the sole write point for *denied* attempts: on every 403 it
writes a `resourceType: 'permission'`, `effect: 'denied'` entry (just the attempted permission — a
denial never reaches the route handler, so there's no resource-specific `before`/`after`) via the
same `auditWriter(c)`. This is an O(1) middleware-level change, not a per-route retrofit — every
gated route already calls `requirePermission`. A failure writing the denial entry is logged and
swallowed, never surfaced as a 500 or allowed to mask the 403.

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

**D-143/D-144 Context Library visibility gate:** every Context has a `visibility` of `personal`
(owner only), `group` (any live member of `groupId`, re-checked per request against
`heediq-role-assignments` — not baked into the JWT, since group membership can change between token
refreshes), or `org` (any authenticated member of the org). `canAccessContext(c, item)` in
`contexts.ts` is the single implementation of this check, imported by `sources.ts`'s review route so
a review can only file items into a context the caller can actually see. `POST /contexts` with
`visibility: 'group'` requires the *creating* caller to already be a member of `groupId` — the same
membership check a reader would need, so a context is never created into a group its own owner
can't read back. `parentContextId` supports one level of nesting for the tree view
(`GET /contexts/tree`); a context with children returns `409 CONFLICT` on `DELETE` rather than
cascading.

**D-143/D-144 review-approval (`POST /sources/:id/review`):** takes `{ contextId, kept: string[] }`
(item ids to keep — everything else extracted from that source is discarded) after gating with
`canAccessContext` on the target context; writes an after-only `source:review` audit event via
`auditWriter(c)` and returns `{ keptCount, discardedCount }`.

**Response envelope:** `{ ok: true, data: T }` | `{ ok: false, error: { code, message, details? } }`

**API version prefix (D-088):** `/api/v1/` is written in exactly one place — the two `app.route()`
calls in `src/app.ts`. Route modules (`routes/*.ts`) never include the prefix themselves; they mount
at their bare resource path (`auth.post('/lookup-email', ...)`) and `app.ts` supplies `/api/v1`. Any
new router follows the same pattern — mount it in `app.ts`, don't hardcode the prefix inside it.

## Dependencies

- Upstream: `heediq-infra` (Lambda + API Gateway + DynamoDB + S3 + SQS must exist before deploy, D-050)
- Upstream: `@heediq/shared` (Zod schemas + types, D-033) — pinned to `^0.15.1` (D-085/D-093 `createLogger` structured logger, mandatory per D-093; `passwordPolicy.ts`'s `isPasswordPolicyCompliant` is consumed in `routes/auth.ts`'s `/link/confirm`, D-094; D-102 adds the 5 RBAC request schemas and `buildAuditLogEntry()`, consumed by `routes/roles.ts`/`groups.ts`/`role-assignments.ts` and `lib/audit.ts`; D-114 adds `audit.ts`'s `effect` field and `permission` resourceType, consumed by `middleware/rbac.ts`; D-143/D-144 adds `Create/UpdateContextRequestSchema`, `ReviewApprovalRequestSchema`, `ExtractedItemSchema`, and the `context`/`extractedItemReview` `AuditPayloadMap` entries, consumed by `routes/contexts.ts` and the review route in `routes/sources.ts`)
- Upstream: `heediq-infra`'s `heediq-contexts`/`heediq-extracted-items` tables + GSIs (D-143/D-144, ApiStack IAM grants + env vars)
- Downstream: `heediq-worker-transcription` (reads SQS messages enqueued here). `config.ts` also reads `SUMMARIZATION_QUEUE_URL`, but no route currently sends to it — the text-upload → summarization-queue direct path isn't wired up yet.
- Shared surfaces: `heediq-sources`, `heediq-jobs`, `heediq-contexts`, `heediq-extracted-items` DynamoDB tables
- Upstream (auth): `heediq-infra`'s `UserAuthMethodsTable`/`AuthAuditLogTable` (D-087) and the Cognito User Pool triggers wired to the 3 `auth-trigger-*.ts` handlers — see `heediq-infra/README.md`
- Upstream (auth): `heediq-infra`'s `heediq-rate-limits` table (D-097) backing `src/lib/rateLimit.ts`

## Testing

```bash
pnpm run test          # 235 unit tests (auth routes + auth methods + settings link + auth triggers + sources + contexts + app routing + rate limiting + roles + groups + role-assignments + rbac + rbac-middleware + me + users + wsPush + ws-connect + ws-pusher + classification-pusher)
pnpm run typecheck     # tsc --noEmit
pnpm run test:pre-pr   # typecheck + test (run before opening a PR)
pnpm run dev           # local dev server on :3000 (tsx watch)
```

`pnpm run dev` calls `requireEnv()` in `config.ts` at cold start and crashes immediately if any of
these 21 vars are unset — all real AWS resources deployed by `heediq-infra`, no local fakes:
`COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `SOURCES_TABLE_NAME`, `ORGS_TABLE_NAME`,
`USERS_TABLE_NAME`, `JOBS_TABLE_NAME`, `WS_CONNECTIONS_TABLE_NAME`, `USER_AUTH_METHODS_TABLE_NAME`,
`AUTH_AUDIT_LOG_TABLE_NAME`, `RATE_LIMITS_TABLE_NAME`, `COGNITO_IDENTITIES_TABLE_NAME`,
`AUDIO_BUCKET_NAME`, `TRANSCRIPTION_QUEUE_URL`, `SUMMARIZATION_QUEUE_URL`, `ROLES_TABLE_NAME`,
`GROUPS_TABLE_NAME`, `ROLE_ASSIGNMENTS_TABLE_NAME`, `AUDIT_LOG_TABLE_NAME`,
`CONTEXTS_TABLE_NAME`, `EXTRACTED_ITEMS_TABLE_NAME`,
`WS_MANAGEMENT_ENDPOINT` (D-109). Pull the actual values
from the deployed `dev` account (SSM params / CDK stack outputs, see `heediq-infra/README.md`) into
a local `.env` and export before running `dev`.

Integration tests (Vitest + DynamoDB Local, D-030) — `tests/integration/**/*.test.ts`, run against a
real local table (not a mock), catching wrong-key-shape/reserved-keyword/query-syntax bugs a mocked
`dynamo.send()` can't:

```bash
pnpm run docker:integration:up    # starts DynamoDB Local on :8000
pnpm run test:integration         # bootstraps tables, then runs the integration suite
pnpm run docker:integration:down  # tears the container down
```

Covers `auth-provision.ts` (Cognito PreTokenGeneration trigger — first-login org provisioning,
federated first-login, identities-table resolution, email self-heal), `lib/rbac.ts`'s
`resolveEffectivePermissions` (direct role, group-mediated, union/dedup, no assignments),
`routes/audit-log.ts`'s `GET /org/audit-log` (permission gate, org-scoped listing, action/
resourceType filter + cross-org isolation, cursor round-trip), and the RBAC/sources route CRUD
surfaces: `routes/roles.ts`, `routes/groups.ts` (including cross-org roleId rejection and roleId
dedup), `routes/role-assignments.ts`, and `routes/sources.ts` (list/pagination/`ownSourcesOnly`
scoping, update/delete existence checks, D-060 tier gating on job enqueue with
`@aws-sdk/client-sqs` mocked since SQS is outside DynamoDB Local's scope). Route-level tests use
the same synthetic-auth-middleware pattern as the mocked unit tests (mount the router directly, set
`userId`/`orgId`/`role`/`permissions` on context), just against the real `dynamo` client.
`tests/integration/scenarios/rbac-journey.test.ts` chains role → group → assignment →
`resolveEffectivePermissions` → audit-log across four routers on one app instance, to catch
composition breaks a single-route test can't. `wsPush.ts`/`ws-connect.ts`/`ws-pusher.ts` remain
unit-test-only for now.

CI runs the integration suite as a gate on every PR targeting `main` (i.e. the `develop`→`main`
staging-promotion PR) — see `integration-test` job in `.github/workflows/ci.yml`. It does not run on
PRs targeting `develop`, to keep that gate fast; unit tests + typecheck still run on every PR either
way.

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
- **Real-time WebSocket framework (D-061, generalized D-109):** `src/handlers/ws-connect.ts` ($connect/$disconnect — validates the JWT passed as a `?token=` query param since browsers can't set custom headers during the WS handshake, then writes/deletes a `heediq-ws-connections` row keyed by `connectionId` with `userId`/`orgId`/`broadcastKey`) and `src/handlers/ws-pusher.ts` (DDB Streams `MODIFY` consumer on `heediq-jobs`, pushes a `job_status` event at org scope) are separate bundled Lambda entry points (own `bundle:ws-connect`/`bundle:ws-pusher` esbuild scripts), same pattern as the `auth-trigger-*` handlers below. `src/handlers/classification-pusher.ts` is a third bundled entry point (`bundle:classification-pusher`) — a DDB Streams consumer on `heediq-sources` (deployed as `heediq-ws-classification-pusher`, wired in `WebSocketStack`) that pushes `classification_ready` when the ingest worker sets `classification='pending_review'` (D-133). `src/lib/wsPush.ts` is the shared fan-out library (`pushToUser`/`pushToOrg`/`pushBroadcast`) any future feature calls directly — it queries the relevant GSI (`by-user`/`by-org`/`by-broadcast`), POSTs via `ApiGatewayManagementApiClient`, and self-heals by deleting a connection row on `GoneException`. `WS_MANAGEMENT_ENDPOINT` is required by `config.ts`'s new `ws` namespace. Note: like `ws-connect`/`ws-pusher`, the pusher bundles are build-ready but not yet wired into `deploy.yml`'s `update-function-code` steps (pre-existing WS-CD gap — the WS handlers deploy manually for now).
- **D-060:** Model access is enforced by fetching the org's `plan` field from DynamoDB on every enqueue request — not cached. Acceptable at MVP scale; add caching if DynamoDB latency becomes a concern.
- **Source list pagination:** cursor is a base64url-encoded DynamoDB `LastEvaluatedKey`. Members only see their own sources (FilterExpression); admins see all org sources.
- **`labels: []` set explicitly on create:** the `Source` object built in `POST /sources` is written directly via `PutCommand`, bypassing `SourceSchema.parse()`, so the schema's `labels` default (`[]`) is set explicitly in code to match what a read-back `.parse()` would produce.
- **Deploy:** CI builds via `pnpm run bundle` (esbuild) and runs `aws lambda update-function-code` per environment, gated by the D-070/D-071 org-level `vars.AWS_REGION` / `vars.DEPLOY_ROLE_ARN`. See `heediq-infra/README.md` §"Initial Setup" for CDK-bootstrap prerequisites (Lambda + API Gateway must be deployed by CDK before this repo's CI can update function code).
- **The 3 `auth-trigger-*.ts` handlers are separate bundled Lambda entry points**, not part of the main API Lambda — each has its own `bundle:auth-trigger-*` esbuild script and its own deploy step in `deploy.yml` per environment, same pattern as `auth-provision.ts`.
- **`custom:accountId` (D-099) required a full Cognito User Pool replacement:** adding a custom attribute changes the User Pool's `Schema`, which CloudFormation can only apply via full resource replacement — this destroys all existing users in whichever environment it's deployed to. Confirmed and accepted for dev; requires explicit sign-off before staging/prod (existing users would need to re-sign-up).
- **D-102 Phase 5 audit-log read path (`routes/audit-log.ts`):** `GET /org/audit-log` queries the base table (`pk = ORG#<orgId>`) by default, or the `by-user` GSI when `actorUserId` is given — the GSI query always adds `orgId = :orgId` to the `FilterExpression` too, as explicit cross-org defense-in-depth even though a user belongs to exactly one org today. The Lambda's IAM grant on this table is `Query` + write only — `GetItem`/`Scan` remain blocked (`heediq-infra` `api-stack.ts`), preserving the "no full-table read" posture from Phase 2. `action` is a DynamoDB reserved keyword — its `FilterExpression` clause must go through `ExpressionAttributeNames` (`#action`); a mocked `dynamo.send()` unit test can't catch a missed case like this, which is what the integration test layer below is for.
- **`create-tables.ts` mirrors `heediq-infra/lib/foundation/tables.ts` by hand:** table/GSI definitions are duplicated, not imported, since `heediq-infra` isn't a runtime dependency of this repo. This can silently drift — if a table/GSI changes in `heediq-infra`, `create-tables.ts` must be updated too, or integration tests will pass locally against a schema real AWS no longer has. Flagged as a cross-repo drift-risk check item in `claude-workspace/rules/10-consistency-check.md`.
- **`dynamo.ts` respects `DYNAMODB_ENDPOINT`:** only ever set by `tests/integration/setup-env.ts` — unset in every deployed Lambda env, so production always targets real AWS DynamoDB.
- **D-105 permission staleness is bounded by token lifetime, not instant:** since `custom:permissions` is baked into the JWT at issuance rather than checked per-request against DynamoDB, a permission change (role edit, reassignment) only takes effect for a given user on their next token refresh — not immediately. This is a deliberate tradeoff (see `DECISIONS.md` D-105) in exchange for zero added DynamoDB reads on the request hot path.
