import { Hono } from 'hono'
import { GetCommand, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import { auditWriter } from '../lib/audit.js'
import { apiError, ok } from '../lib/errors.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import type { RequestIdContext } from '../middleware/request-id.js'
import { canAccessContext } from './contexts.js'
import {
  ContextSchema,
  ContextGrantSchema,
  CreateContextGrantRequestSchema,
  createLogger,
} from '@heediq/shared'

const logger = createLogger('heediq-api')

type ContextGrantsContext = AuthContext & RequestIdContext

const contextGrants = new Hono<ContextGrantsContext>()

// Cross-org sharing targets an existing Heediq account only (D-142 scope — no invite/magic-link
// flow yet); a miss here is reported as the grantee not being found, not a generic 500.
async function resolveGranteeByEmail(email: string): Promise<{ userId: string; orgId: string } | undefined> {
  const res = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.usersTable,
    IndexName: 'by-email',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: { ':email': email },
    Limit: 1,
  }))
  const item = res.Items?.[0]
  if (!item) return undefined
  return { userId: item['userId'] as string, orgId: item['orgId'] as string }
}

// POST /api/v1/context-grants — issue or renew a cross-org grant on a Context this caller can
// already access (D-142). `context:share` is admin/owner-gated (D-141) so a member can't widen
// their own Contexts past the org boundary. Re-sharing to the same grantee overwrites the existing
// grant (same PK/SK = same identity, D-142 — no separate history to preserve).
contextGrants.post('/', requirePermission('context:share'), async (c) => {
  const orgId = c.get('orgId')
  const userId = c.get('userId')
  const body = await c.req.json()
  const parsed = CreateContextGrantRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }
  const { granteeEmail, access, expiresAt } = parsed.data

  const contextId = c.req.query('contextId')
  if (!contextId) {
    return apiError(c, 'BAD_REQUEST', 'Missing contextId query parameter')
  }
  const contextRes = await dynamo.send(new GetCommand({ TableName: config.dynamo.contextsTable, Key: { contextId } }))
  if (!contextRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }
  const context = ContextSchema.parse(contextRes.Item)
  if (!(await canAccessContext(c, context))) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }

  if (expiresAt <= Math.floor(Date.now() / 1000)) {
    return apiError(c, 'BAD_REQUEST', 'expiresAt must be in the future')
  }

  const grantee = await resolveGranteeByEmail(granteeEmail)
  if (!grantee) {
    return apiError(c, 'BAD_REQUEST', 'No Heediq account found for that email')
  }
  if (grantee.orgId === orgId) {
    return apiError(c, 'BAD_REQUEST', 'Grants are for cross-org sharing — grantee is already in your org')
  }

  const now = new Date().toISOString()
  const grant = ContextGrantSchema.parse({
    contextId,
    granteeUserId: grantee.userId,
    granteeOrgId: grantee.orgId,
    ownerOrgId: orgId,
    grantedByUserId: userId,
    access,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  })
  await dynamo.send(new PutCommand({ TableName: config.dynamo.contextGrantsTable, Item: grant }))

  logger.info('Context grant issued', { requestId: c.get('requestId'), contextId, granteeUserId: grantee.userId, orgId })
  await auditWriter(c)({
    resourceType: 'contextGrant',
    action: 'context:share',
    after: { contextId, granteeUserId: grantee.userId, granteeOrgId: grantee.orgId, access, expiresAt },
  })
  return ok(c, { grant }, 201)
})

// GET /api/v1/context-grants?contextId=... — the owner-side view: who a Context is currently
// shared with (D-142's by-context GSI).
contextGrants.get('/', requirePermission('context:share'), async (c) => {
  const contextId = c.req.query('contextId')
  if (!contextId) {
    return apiError(c, 'BAD_REQUEST', 'Missing contextId query parameter')
  }
  const contextRes = await dynamo.send(new GetCommand({ TableName: config.dynamo.contextsTable, Key: { contextId } }))
  if (!contextRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }
  if (!(await canAccessContext(c, ContextSchema.parse(contextRes.Item)))) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }

  const res = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.contextGrantsTable,
    IndexName: 'by-context',
    KeyConditionExpression: 'contextId = :contextId',
    ExpressionAttributeValues: { ':contextId': contextId },
  }))
  const grants = (res.Items ?? []).map((i) => ContextGrantSchema.parse(i))
  return ok(c, { grants })
})

// GET /api/v1/context-grants/shared-with-me — the grantee-side view: every Context currently
// shared with the caller, across every owner org. Always the caller's own grants (no permission
// gate beyond auth) — this is what the caller can already see, not a management action.
contextGrants.get('/shared-with-me', async (c) => {
  const userId = c.get('userId')
  const res = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.contextGrantsTable,
    KeyConditionExpression: 'granteeUserId = :granteeUserId',
    ExpressionAttributeValues: { ':granteeUserId': userId },
  }))
  const nowEpoch = Math.floor(Date.now() / 1000)
  const grants = (res.Items ?? [])
    .map((i) => ContextGrantSchema.parse(i))
    .filter((g) => g.expiresAt > nowEpoch)
  return ok(c, { grants })
})

// DELETE /api/v1/context-grants/:contextId/:granteeUserId — revoke. A hard delete is the record
// (no status/revokedAt by design, D-142) — the audit entry (before-only) is what preserves history.
contextGrants.delete('/:contextId/:granteeUserId', requirePermission('context:share'), async (c) => {
  const orgId = c.get('orgId')
  const contextId = c.req.param('contextId')
  const granteeUserId = c.req.param('granteeUserId')

  const existingRes = await dynamo.send(new GetCommand({
    TableName: config.dynamo.contextGrantsTable,
    Key: { granteeUserId, contextId },
  }))
  if (!existingRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Grant not found')
  }
  const grant = ContextGrantSchema.parse(existingRes.Item)
  if (grant.ownerOrgId !== orgId) {
    return apiError(c, 'NOT_FOUND', 'Grant not found')
  }

  await dynamo.send(new DeleteCommand({
    TableName: config.dynamo.contextGrantsTable,
    Key: { granteeUserId, contextId },
  }))

  logger.info('Context grant revoked', { requestId: c.get('requestId'), contextId, granteeUserId, orgId })
  await auditWriter(c)({
    resourceType: 'contextGrant',
    action: 'context:unshare',
    before: { contextId, granteeUserId, granteeOrgId: grant.granteeOrgId, access: grant.access, expiresAt: grant.expiresAt },
  })
  return ok(c, { revoked: true })
})

export { contextGrants as contextGrantsRouter }
