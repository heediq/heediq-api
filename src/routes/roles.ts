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
import { RoleSchema, CreateRoleRequestSchema, UpdateRoleRequestSchema, createLogger, type Role } from '@heediq/shared'

const logger = createLogger('heediq-api')

type RolesContext = AuthContext & RequestIdContext

const roles = new Hono<RolesContext>()

function isAwsError(err: unknown): err is { name: string } {
  return typeof err === 'object' && err !== null && 'name' in err
}

// GET /api/v1/roles — list org roles
roles.get('/', async (c) => {
  const orgId = c.get('orgId')
  const result = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.rolesTable,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `ORG#${orgId}`, ':skPrefix': 'ROLE#' },
  }))
  const items = (result.Items ?? []).map((i) => RoleSchema.parse(i))
  return ok(c, { roles: items })
})

// POST /api/v1/roles — create role
roles.post('/', requirePermission('org:manage-roles'), async (c) => {
  const orgId = c.get('orgId')
  const body = await c.req.json()
  const parsed = CreateRoleRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const now = new Date().toISOString()
  const roleId = randomUUID()
  const role: Role = {
    orgId,
    roleId,
    name: parsed.data.name,
    permissions: parsed.data.permissions,
    isSystemRole: false,
    createdAt: now,
    updatedAt: now,
  }

  await dynamo.send(new PutCommand({
    TableName: config.dynamo.rolesTable,
    Item: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId}`, ...role },
  }))
  logger.info('Role created', { requestId: c.get('requestId'), orgId, roleId })
  await auditWriter(c)({
    resourceType: 'role',
    action: 'role:create',
    after: { roleId, name: role.name, permissions: role.permissions },
  })
  return ok(c, { role }, 201)
})

// GET /api/v1/roles/:id
roles.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const res = await dynamo.send(new GetCommand({
    TableName: config.dynamo.rolesTable,
    Key: { pk: `ORG#${orgId}`, sk: `ROLE#${id}` },
  }))
  if (!res.Item) {
    return apiError(c, 'NOT_FOUND', 'Role not found')
  }
  return ok(c, { role: RoleSchema.parse(res.Item) })
})

// PATCH /api/v1/roles/:id
roles.patch('/:id', requirePermission('org:manage-roles'), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const body = await c.req.json()
  const parsed = UpdateRoleRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const key = { pk: `ORG#${orgId}`, sk: `ROLE#${id}` }
  const existingRes = await dynamo.send(new GetCommand({ TableName: config.dynamo.rolesTable, Key: key }))
  if (!existingRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Role not found')
  }
  const before = RoleSchema.parse(existingRes.Item)

  const now = new Date().toISOString()
  const updates: string[] = ['updatedAt = :now']
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = { ':now': now }
  if (parsed.data.name !== undefined) {
    updates.push('#name = :name')
    names['#name'] = 'name'
    values[':name'] = parsed.data.name
  }
  if (parsed.data.permissions !== undefined) {
    // `permissions` is a DynamoDB reserved word — must be aliased, same as `name` above.
    updates.push('#permissions = :permissions')
    names['#permissions'] = 'permissions'
    values[':permissions'] = parsed.data.permissions
  }

  let res
  try {
    res = await dynamo.send(new UpdateCommand({
      TableName: config.dynamo.rolesTable,
      Key: key,
      ConditionExpression: 'attribute_exists(sk)',
      UpdateExpression: `SET ${updates.join(', ')}`,
      ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }))
  } catch (err: unknown) {
    if (isAwsError(err) && err.name === 'ConditionalCheckFailedException') {
      return apiError(c, 'NOT_FOUND', 'Role not found')
    }
    throw err
  }

  const after = RoleSchema.parse(res.Attributes)
  logger.info('Role updated', { requestId: c.get('requestId'), orgId, roleId: id })
  await auditWriter(c)({
    resourceType: 'role',
    action: 'role:update',
    before: { roleId: id, name: before.name, permissions: before.permissions },
    after: { roleId: id, name: after.name, permissions: after.permissions },
  })
  return ok(c, { role: after })
})

// DELETE /api/v1/roles/:id — system roles (admin/member) cannot be deleted
roles.delete('/:id', requirePermission('org:manage-roles'), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const key = { pk: `ORG#${orgId}`, sk: `ROLE#${id}` }

  const existingRes = await dynamo.send(new GetCommand({ TableName: config.dynamo.rolesTable, Key: key }))
  if (!existingRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Role not found')
  }
  const before = RoleSchema.parse(existingRes.Item)
  if (before.isSystemRole) {
    return apiError(c, 'CONFLICT', 'System roles (admin/member) cannot be deleted')
  }

  try {
    await dynamo.send(new DeleteCommand({
      TableName: config.dynamo.rolesTable,
      Key: key,
      ConditionExpression: 'attribute_exists(sk)',
    }))
  } catch (err: unknown) {
    if (isAwsError(err) && err.name === 'ConditionalCheckFailedException') {
      return apiError(c, 'NOT_FOUND', 'Role not found')
    }
    throw err
  }

  logger.info('Role deleted', { requestId: c.get('requestId'), orgId, roleId: id })
  await auditWriter(c)({
    resourceType: 'role',
    action: 'role:delete',
    before: { roleId: id, name: before.name, permissions: before.permissions },
  })
  return ok(c, { deleted: true })
})

export { roles as rolesRouter }
