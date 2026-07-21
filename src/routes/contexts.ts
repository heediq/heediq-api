import { Hono } from 'hono'
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'crypto'
import { dynamo } from '../lib/dynamo.js'
import { auditWriter } from '../lib/audit.js'
import { apiError, ok } from '../lib/errors.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import type { RequestIdContext } from '../middleware/request-id.js'
import {
  ContextSchema,
  ContextGrantSchema,
  CreateContextRequestSchema,
  UpdateContextRequestSchema,
  createLogger,
  type Context as ContextItem,
} from '@heediq/shared'

const logger = createLogger('heediq-api')

type ContextsContext = AuthContext & RequestIdContext

const contexts = new Hono<ContextsContext>()

function isAwsError(err: unknown): err is { name: string } {
  return typeof err === 'object' && err !== null && 'name' in err
}

function scopeKeyFor(visibility: 'personal' | 'group' | 'org', userId: string, orgId: string, groupId?: string): string {
  if (visibility === 'personal') return `U#${userId}`
  if (visibility === 'group') return `G#${groupId}`
  return `O#${orgId}`
}

// A Context's `by-scope` GSI partition is deliberately not a by-org index (D-021 — it would leak
// every member's personal Contexts org-wide), so cross-org isolation on a single-item fetch is
// enforced here by hand: PK=contextId alone doesn't imply the caller's org.
function isSameOrg(orgId: string, item: ContextItem): boolean {
  return item.orgId === orgId
}

// Group-scoped membership isn't in the JWT (no `custom:groups` claim, D-105 keeps the token
// lean), so this reads the caller's own group assignments straight from the RBAC table —
// the same table role-assignments.ts uses. Called only on the group-visibility path, not on
// every request.
async function callerGroupIds(orgId: string, userId: string): Promise<Set<string>> {
  const res = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.roleAssignmentsTable,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `ORG#${orgId}#USER#${userId}`, ':skPrefix': 'GROUP#' },
  }))
  return new Set((res.Items ?? []).map((i) => (i['sk'] as string).slice('GROUP#'.length)))
}

const GRANT_ACCESS_RANK: Record<'read' | 'contribute', number> = { read: 0, contribute: 1 }

// A grant is checked live against DynamoDB on every call (never cached in the JWT, D-142) —
// unlike requirePermission's in-token check, cross-org access must reflect a revoke immediately.
// TTL on `heediq-context-grants` is cleanup-only (D-097 precedent): DynamoDB's TTL sweep can lag
// up to 48h, so an expired-but-not-yet-swept row must still be rejected here, not trusted as absent.
async function hasActiveGrant(granteeUserId: string, contextId: string, minAccess: 'read' | 'contribute'): Promise<boolean> {
  const res = await dynamo.send(new GetCommand({
    TableName: config.dynamo.contextGrantsTable,
    Key: { granteeUserId, contextId },
  }))
  if (!res.Item) return false
  const grant = ContextGrantSchema.parse(res.Item)
  if (grant.expiresAt <= Math.floor(Date.now() / 1000)) return false
  return GRANT_ACCESS_RANK[grant.access] >= GRANT_ACCESS_RANK[minAccess]
}

// Visibility gate for a specific Context instance (D-141): personal is owner-only regardless of
// org-wide context:* permissions — a member with context:update can't edit someone else's private
// notebook. Group requires live membership; org is open to any org member (already isolated by
// isSameOrg above).
//
// `minAccess` is deliberately omitted by PATCH/DELETE (stays undefined there) so a cross-org grant
// can never authorize mutating the Context entity itself (D-142) — only routes that pass it (the
// GET fetch, and sources.ts's review-approval route at 'contribute') fall through to a live grant
// lookup when the caller isn't the owner/org/group member.
export async function canAccessContext(
  c: { get: (k: 'orgId' | 'userId') => string },
  item: ContextItem,
  minAccess?: 'read' | 'contribute',
): Promise<boolean> {
  if (isSameOrg(c.get('orgId'), item)) {
    if (item.visibility === 'org') return true
    if (item.visibility === 'personal') {
      if (item.userId === c.get('userId')) return true
    } else {
      const groups = await callerGroupIds(c.get('orgId'), c.get('userId'))
      if (item.userId === c.get('userId') || (item.groupId !== undefined && groups.has(item.groupId))) return true
    }
  }
  if (minAccess === undefined) return false
  return hasActiveGrant(c.get('userId'), item.contextId, minAccess)
}

// GET /api/v1/contexts — personal (own) + org-visible Contexts, optionally filtered to one
// Domain. Group-scoped listing is deferred (needs the same group-membership read as
// canAccessContext, folded into step 4c alongside the grant/chat routes) — a group Context is
// still individually reachable via GET /:id for a member, just not listed here yet.
contexts.get('/', async (c) => {
  const orgId = c.get('orgId')
  const userId = c.get('userId')
  const domain = c.req.query('domain')
  const skCondition = domain
    ? 'begins_with(domainCreatedAt, :domainPrefix)'
    : undefined

  const queryScope = (scopeKey: string) => dynamo.send(new QueryCommand({
    TableName: config.dynamo.contextsTable,
    IndexName: 'by-scope',
    KeyConditionExpression: skCondition ? `scopeKey = :scopeKey AND ${skCondition}` : 'scopeKey = :scopeKey',
    ExpressionAttributeValues: {
      ':scopeKey': scopeKey,
      ...(domain && { ':domainPrefix': `${domain}#` }),
    },
    ScanIndexForward: false,
  }))

  const [personalRes, orgRes] = await Promise.all([
    queryScope(`U#${userId}`),
    queryScope(`O#${orgId}`),
  ])
  const items = [...(personalRes.Items ?? []), ...(orgRes.Items ?? [])].map((i) => ContextSchema.parse(i))
  return ok(c, { contexts: items })
})

// GET /api/v1/contexts/tree — same scope as the list above, nested by parentContextId. A node
// whose parent isn't in the caller's visible set (a different scope, or missing) surfaces as its
// own root rather than being dropped, so nothing silently disappears.
contexts.get('/tree', async (c) => {
  const orgId = c.get('orgId')
  const userId = c.get('userId')

  const queryScope = (scopeKey: string) => dynamo.send(new QueryCommand({
    TableName: config.dynamo.contextsTable,
    IndexName: 'by-scope',
    KeyConditionExpression: 'scopeKey = :scopeKey',
    ExpressionAttributeValues: { ':scopeKey': scopeKey },
  }))

  const [personalRes, orgRes] = await Promise.all([
    queryScope(`U#${userId}`),
    queryScope(`O#${orgId}`),
  ])
  const items = [...(personalRes.Items ?? []), ...(orgRes.Items ?? [])].map((i) => ContextSchema.parse(i))

  type TreeNode = ContextItem & { children: TreeNode[] }
  const byId = new Map<string, TreeNode>(items.map((i) => [i.contextId, { ...i, children: [] }]))
  const roots: TreeNode[] = []
  for (const node of byId.values()) {
    const parent = node.parentContextId ? byId.get(node.parentContextId) : undefined
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return ok(c, { tree: roots })
})

// POST /api/v1/contexts — create a Context. Writer computes scopeKey/domainCreatedAt (non-key
// attrs the `by-scope` GSI keys off) so every caller — this route, and later the ingest
// classifier's auto-created Contexts — stays consistent with the GSI's contract (D-141).
contexts.post('/', requirePermission('context:create'), async (c) => {
  const orgId = c.get('orgId')
  const userId = c.get('userId')
  const body = await c.req.json()
  const parsed = CreateContextRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const visibility = parsed.data.visibility ?? 'personal'
  if (visibility === 'group') {
    const groups = await callerGroupIds(orgId, userId)
    if (!groups.has(parsed.data.groupId as string)) {
      return apiError(c, 'BAD_REQUEST', 'Not a member of the specified group')
    }
  }

  if (parsed.data.parentContextId) {
    const parentRes = await dynamo.send(new GetCommand({
      TableName: config.dynamo.contextsTable,
      Key: { contextId: parsed.data.parentContextId },
    }))
    if (!parentRes.Item || !(await canAccessContext(c, ContextSchema.parse(parentRes.Item)))) {
      return apiError(c, 'BAD_REQUEST', 'Parent context not found or not visible to you')
    }
  }

  const now = new Date().toISOString()
  const contextId = randomUUID()
  const context: ContextItem = {
    contextId,
    orgId,
    userId,
    domain: parsed.data.domain,
    name: parsed.data.name,
    ...(parsed.data.description !== undefined && { description: parsed.data.description }),
    ...(parsed.data.parentContextId !== undefined && { parentContextId: parsed.data.parentContextId }),
    visibility,
    ...(parsed.data.groupId !== undefined && { groupId: parsed.data.groupId }),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }

  await dynamo.send(new PutCommand({
    TableName: config.dynamo.contextsTable,
    Item: {
      ...context,
      scopeKey: scopeKeyFor(visibility, userId, orgId, parsed.data.groupId),
      domainCreatedAt: `${context.domain}#${now}`,
    },
  }))
  logger.info('Context created', { requestId: c.get('requestId'), contextId, orgId })
  await auditWriter(c)({
    resourceType: 'context',
    action: 'context:create',
    after: { contextId, name: context.name, domain: context.domain, visibility: context.visibility, parentContextId: context.parentContextId },
  })
  return ok(c, { context }, 201)
})

// GET /api/v1/contexts/:id
contexts.get('/:id', async (c) => {
  const id = c.req.param('id')
  const res = await dynamo.send(new GetCommand({
    TableName: config.dynamo.contextsTable,
    Key: { contextId: id },
  }))
  if (!res.Item) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }
  const item = ContextSchema.parse(res.Item)
  if (!(await canAccessContext(c, item, 'read'))) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }
  return ok(c, { context: item })
})

// PATCH /api/v1/contexts/:id
contexts.patch('/:id', requirePermission('context:update'), async (c) => {
  const orgId = c.get('orgId')
  const userId = c.get('userId')
  const id = c.req.param('id')
  const body = await c.req.json()
  const parsed = UpdateContextRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const existingRes = await dynamo.send(new GetCommand({ TableName: config.dynamo.contextsTable, Key: { contextId: id } }))
  if (!existingRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }
  const before = ContextSchema.parse(existingRes.Item)
  if (!(await canAccessContext(c, before))) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }

  // Resolve against the *stored* visibility/groupId, not just this patch, since a partial
  // update can touch only one side of the pair while the other stays at its current value.
  const resultVisibility = parsed.data.visibility ?? before.visibility
  const resultGroupId = parsed.data.groupId ?? before.groupId
  if ((resultVisibility === 'group') !== (resultGroupId !== undefined)) {
    return apiError(c, 'BAD_REQUEST', 'groupId must be set iff visibility is "group"')
  }
  if (resultVisibility === 'group' && parsed.data.groupId !== undefined) {
    const groups = await callerGroupIds(orgId, userId)
    if (!groups.has(parsed.data.groupId)) {
      return apiError(c, 'BAD_REQUEST', 'Not a member of the specified group')
    }
  }
  if (parsed.data.parentContextId !== undefined) {
    if (parsed.data.parentContextId === id) {
      return apiError(c, 'BAD_REQUEST', 'A context cannot be its own parent')
    }
    const parentRes = await dynamo.send(new GetCommand({ TableName: config.dynamo.contextsTable, Key: { contextId: parsed.data.parentContextId } }))
    if (!parentRes.Item || !(await canAccessContext(c, ContextSchema.parse(parentRes.Item)))) {
      return apiError(c, 'BAD_REQUEST', 'Parent context not found or not visible to you')
    }
  }

  const now = new Date().toISOString()
  const updates: string[] = ['updatedAt = :now']
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = { ':now': now }
  if (parsed.data.name !== undefined) {
    updates.push('#name = :name')
    names['#name'] = 'name'
    values[':name'] = parsed.data.name
  }
  if (parsed.data.description !== undefined) {
    updates.push('description = :description')
    values[':description'] = parsed.data.description
  }
  if (parsed.data.parentContextId !== undefined) {
    updates.push('parentContextId = :parentContextId')
    values[':parentContextId'] = parsed.data.parentContextId
  }
  if (parsed.data.visibility !== undefined || parsed.data.groupId !== undefined) {
    updates.push('visibility = :visibility', 'scopeKey = :scopeKey')
    values[':visibility'] = resultVisibility
    values[':scopeKey'] = scopeKeyFor(resultVisibility, before.userId, orgId, resultGroupId)
    if (resultGroupId !== undefined) {
      updates.push('groupId = :groupId')
      values[':groupId'] = resultGroupId
    }
  }

  let res
  try {
    res = await dynamo.send(new UpdateCommand({
      TableName: config.dynamo.contextsTable,
      Key: { contextId: id },
      ConditionExpression: 'attribute_exists(contextId)',
      UpdateExpression: `SET ${updates.join(', ')}`,
      ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }))
  } catch (err: unknown) {
    if (isAwsError(err) && err.name === 'ConditionalCheckFailedException') {
      return apiError(c, 'NOT_FOUND', 'Context not found')
    }
    throw err
  }

  const after = ContextSchema.parse(res.Attributes)
  logger.info('Context updated', { requestId: c.get('requestId'), contextId: id, orgId })
  await auditWriter(c)({
    resourceType: 'context',
    action: 'context:update',
    before: { contextId: before.contextId, name: before.name, domain: before.domain, visibility: before.visibility, parentContextId: before.parentContextId },
    after: { contextId: after.contextId, name: after.name, domain: after.domain, visibility: after.visibility, parentContextId: after.parentContextId },
  })
  return ok(c, { context: after })
})

// DELETE /api/v1/contexts/:id — 409 if child Contexts exist (no orphaning). Child detection
// queries the parent's own by-scope partition (same scope+domain the parent was created in);
// this is a deliberate best-effort scoped to how Contexts are expected to nest, not a table scan
// (D-103's DynamoDB access-pattern discipline — see contexts.ts README note).
contexts.delete('/:id', requirePermission('context:delete'), async (c) => {
  const id = c.req.param('id')
  const existingRes = await dynamo.send(new GetCommand({ TableName: config.dynamo.contextsTable, Key: { contextId: id } }))
  if (!existingRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }
  const before = ContextSchema.parse(existingRes.Item)
  if (!(await canAccessContext(c, before))) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }

  const scopeKey = scopeKeyFor(before.visibility, before.userId, before.orgId, before.groupId)
  const childrenRes = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.contextsTable,
    IndexName: 'by-scope',
    KeyConditionExpression: 'scopeKey = :scopeKey AND begins_with(domainCreatedAt, :domainPrefix)',
    FilterExpression: 'parentContextId = :id',
    ExpressionAttributeValues: { ':scopeKey': scopeKey, ':domainPrefix': `${before.domain}#`, ':id': id },
  }))
  if ((childrenRes.Items ?? []).length > 0) {
    return apiError(c, 'CONFLICT', 'Context has child contexts — move or delete them first')
  }

  try {
    await dynamo.send(new DeleteCommand({
      TableName: config.dynamo.contextsTable,
      Key: { contextId: id },
      ConditionExpression: 'attribute_exists(contextId)',
    }))
  } catch (err: unknown) {
    if (isAwsError(err) && err.name === 'ConditionalCheckFailedException') {
      return apiError(c, 'NOT_FOUND', 'Context not found')
    }
    throw err
  }

  logger.info('Context deleted', { requestId: c.get('requestId'), contextId: id, orgId: before.orgId })
  await auditWriter(c)({
    resourceType: 'context',
    action: 'context:delete',
    before: { contextId: before.contextId, name: before.name, domain: before.domain, visibility: before.visibility, parentContextId: before.parentContextId },
  })
  return ok(c, { deleted: true })
})

export { contexts as contextsRouter }
