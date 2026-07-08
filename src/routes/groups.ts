import { Hono, type Context } from 'hono'
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'crypto'
import { dynamo } from '../lib/dynamo.js'
import { writeAuditEvent } from '../lib/audit.js'
import { apiError, ok } from '../lib/errors.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import type { RequestIdContext } from '../middleware/request-id.js'
import { GroupSchema, CreateGroupRequestSchema, UpdateGroupRequestSchema, createLogger, type Group } from '@heediq/shared'

const logger = createLogger('heediq-api')

type GroupsContext = AuthContext & RequestIdContext

const groups = new Hono<GroupsContext>()

function isAwsError(err: unknown): err is { name: string } {
  return typeof err === 'object' && err !== null && 'name' in err
}

// Interim write gate — see roles.ts for rationale (D-102 permission enforcement lands later).
function requireAdmin(c: Context<GroupsContext>): boolean {
  return c.get('role') === 'admin'
}

// Confirms every roleId in the list resolves to a role row in this org — a group must never
// reference a role that doesn't exist (or belongs to another org).
async function allRoleIdsExistInOrg(orgId: string, roleIds: string[]): Promise<boolean> {
  if (roleIds.length === 0) return true
  const keys = [...new Set(roleIds)].map((roleId) => ({ pk: `ORG#${orgId}`, sk: `ROLE#${roleId}` }))
  const result = await dynamo.send(new BatchGetCommand({
    RequestItems: { [config.dynamo.rolesTable]: { Keys: keys } },
  }))
  const found = result.Responses?.[config.dynamo.rolesTable]?.length ?? 0
  return found === keys.length
}

// GET /api/v1/groups — list org groups
groups.get('/', async (c) => {
  const orgId = c.get('orgId')
  const result = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.groupsTable,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `ORG#${orgId}`, ':skPrefix': 'GROUP#' },
  }))
  const items = (result.Items ?? []).map((i) => GroupSchema.parse(i))
  return ok(c, { groups: items })
})

// POST /api/v1/groups — create group (admin-only)
groups.post('/', async (c) => {
  if (!requireAdmin(c)) {
    return apiError(c, 'FORBIDDEN', 'Only org admins can manage groups')
  }
  const orgId = c.get('orgId')
  const body = await c.req.json()
  const parsed = CreateGroupRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }
  if (!(await allRoleIdsExistInOrg(orgId, parsed.data.roleIds))) {
    return apiError(c, 'BAD_REQUEST', 'One or more roleIds do not exist in this org')
  }

  const now = new Date().toISOString()
  const groupId = randomUUID()
  const group: Group = {
    orgId,
    groupId,
    name: parsed.data.name,
    roleIds: parsed.data.roleIds,
    createdAt: now,
    updatedAt: now,
  }

  await dynamo.send(new PutCommand({
    TableName: config.dynamo.groupsTable,
    Item: { pk: `ORG#${orgId}`, sk: `GROUP#${groupId}`, ...group },
  }))
  logger.info('Group created', { requestId: c.get('requestId'), orgId, groupId })
  await writeAuditEvent({
    orgId,
    resourceType: 'group',
    action: 'group:create',
    actorUserId: c.get('userId'),
    actorEmail: c.get('email'),
    after: { groupId, name: group.name, roleIds: group.roleIds },
  })
  return ok(c, { group }, 201)
})

// GET /api/v1/groups/:id
groups.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const res = await dynamo.send(new GetCommand({
    TableName: config.dynamo.groupsTable,
    Key: { pk: `ORG#${orgId}`, sk: `GROUP#${id}` },
  }))
  if (!res.Item) {
    return apiError(c, 'NOT_FOUND', 'Group not found')
  }
  return ok(c, { group: GroupSchema.parse(res.Item) })
})

// PATCH /api/v1/groups/:id — admin-only
groups.patch('/:id', async (c) => {
  if (!requireAdmin(c)) {
    return apiError(c, 'FORBIDDEN', 'Only org admins can manage groups')
  }
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const body = await c.req.json()
  const parsed = UpdateGroupRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }
  if (parsed.data.roleIds !== undefined && !(await allRoleIdsExistInOrg(orgId, parsed.data.roleIds))) {
    return apiError(c, 'BAD_REQUEST', 'One or more roleIds do not exist in this org')
  }

  const key = { pk: `ORG#${orgId}`, sk: `GROUP#${id}` }
  const existingRes = await dynamo.send(new GetCommand({ TableName: config.dynamo.groupsTable, Key: key }))
  if (!existingRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Group not found')
  }
  const before = GroupSchema.parse(existingRes.Item)

  const now = new Date().toISOString()
  const updates: string[] = ['updatedAt = :now']
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = { ':now': now }
  if (parsed.data.name !== undefined) {
    updates.push('#name = :name')
    names['#name'] = 'name'
    values[':name'] = parsed.data.name
  }
  if (parsed.data.roleIds !== undefined) {
    updates.push('roleIds = :roleIds')
    values[':roleIds'] = parsed.data.roleIds
  }

  let res
  try {
    res = await dynamo.send(new UpdateCommand({
      TableName: config.dynamo.groupsTable,
      Key: key,
      ConditionExpression: 'attribute_exists(sk)',
      UpdateExpression: `SET ${updates.join(', ')}`,
      ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }))
  } catch (err: unknown) {
    if (isAwsError(err) && err.name === 'ConditionalCheckFailedException') {
      return apiError(c, 'NOT_FOUND', 'Group not found')
    }
    throw err
  }

  const after = GroupSchema.parse(res.Attributes)
  logger.info('Group updated', { requestId: c.get('requestId'), orgId, groupId: id })
  await writeAuditEvent({
    orgId,
    resourceType: 'group',
    action: 'group:update',
    actorUserId: c.get('userId'),
    actorEmail: c.get('email'),
    before: { groupId: id, name: before.name, roleIds: before.roleIds },
    after: { groupId: id, name: after.name, roleIds: after.roleIds },
  })
  return ok(c, { group: after })
})

// DELETE /api/v1/groups/:id — admin-only
groups.delete('/:id', async (c) => {
  if (!requireAdmin(c)) {
    return apiError(c, 'FORBIDDEN', 'Only org admins can manage groups')
  }
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const key = { pk: `ORG#${orgId}`, sk: `GROUP#${id}` }

  const existingRes = await dynamo.send(new GetCommand({ TableName: config.dynamo.groupsTable, Key: key }))
  if (!existingRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Group not found')
  }
  const before = GroupSchema.parse(existingRes.Item)

  try {
    await dynamo.send(new DeleteCommand({
      TableName: config.dynamo.groupsTable,
      Key: key,
      ConditionExpression: 'attribute_exists(sk)',
    }))
  } catch (err: unknown) {
    if (isAwsError(err) && err.name === 'ConditionalCheckFailedException') {
      return apiError(c, 'NOT_FOUND', 'Group not found')
    }
    throw err
  }

  logger.info('Group deleted', { requestId: c.get('requestId'), orgId, groupId: id })
  await writeAuditEvent({
    orgId,
    resourceType: 'group',
    action: 'group:delete',
    actorUserId: c.get('userId'),
    actorEmail: c.get('email'),
    before: { groupId: id, name: before.name, roleIds: before.roleIds },
  })
  return ok(c, { deleted: true })
})

export { groups as groupsRouter }
