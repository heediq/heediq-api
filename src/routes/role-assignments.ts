import { Hono } from 'hono'
import { GetCommand, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import { auditWriter } from '../lib/audit.js'
import { apiError, ok } from '../lib/errors.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import type { RequestIdContext } from '../middleware/request-id.js'
import {
  RoleAssignmentSchema,
  CreateRoleAssignmentRequestSchema,
  createLogger,
  type RoleAssignment,
  type Role,
  type Group,
} from '@heediq/shared'

const logger = createLogger('heediq-api')

type RoleAssignmentsContext = AuthContext & RequestIdContext

const roleAssignments = new Hono<RoleAssignmentsContext>()

function isAwsError(err: unknown): err is { name: string } {
  return typeof err === 'object' && err !== null && 'name' in err
}

// GET /api/v1/users/:userId/role-assignments — list a user's direct role/group assignments
roleAssignments.get('/:userId/role-assignments', async (c) => {
  const orgId = c.get('orgId')
  const targetUserId = c.req.param('userId')
  const result = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.roleAssignmentsTable,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': `ORG#${orgId}#USER#${targetUserId}` },
  }))
  const items = (result.Items ?? []).map((i) => RoleAssignmentSchema.parse(i))
  return ok(c, { roleAssignments: items })
})

// POST /api/v1/users/:userId/role-assignments — assign a role or group
roleAssignments.post('/:userId/role-assignments', requirePermission('org:manage-roles'), async (c) => {
  const orgId = c.get('orgId')
  const targetUserId = c.req.param('userId')
  const body = await c.req.json()
  const parsed = CreateRoleAssignmentRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const targetUserRes = await dynamo.send(new GetCommand({
    TableName: config.dynamo.usersTable,
    Key: { userId: targetUserId },
  }))
  if (!targetUserRes.Item) {
    return apiError(c, 'NOT_FOUND', 'User not found')
  }
  const targetUserEmail = targetUserRes.Item['email'] as string

  const now = new Date().toISOString()
  const pk = `ORG#${orgId}#USER#${targetUserId}`

  if (parsed.data.assignmentType === 'role') {
    const roleId = parsed.data.roleId
    const roleRes = await dynamo.send(new GetCommand({
      TableName: config.dynamo.rolesTable,
      Key: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId}` },
    }))
    if (!roleRes.Item) {
      return apiError(c, 'BAD_REQUEST', 'roleId does not exist in this org')
    }
    const role = roleRes.Item as Role

    const assignment: RoleAssignment = { assignmentType: 'role', userId: targetUserId, roleId, createdAt: now }
    await dynamo.send(new PutCommand({
      TableName: config.dynamo.roleAssignmentsTable,
      Item: { pk, sk: `ROLE#${roleId}`, ...assignment },
    }))
    logger.info('Role assigned', { requestId: c.get('requestId'), orgId, targetUserId, roleId })
    await auditWriter(c)({
      resourceType: 'roleAssignment',
      action: 'roleAssignment:create',
      after: { userId: targetUserId, userEmail: targetUserEmail, roleId, roleName: role.name },
    })
    return ok(c, { roleAssignment: assignment }, 201)
  }

  const groupId = parsed.data.groupId
  const groupRes = await dynamo.send(new GetCommand({
    TableName: config.dynamo.groupsTable,
    Key: { pk: `ORG#${orgId}`, sk: `GROUP#${groupId}` },
  }))
  if (!groupRes.Item) {
    return apiError(c, 'BAD_REQUEST', 'groupId does not exist in this org')
  }
  const group = groupRes.Item as Group

  const assignment: RoleAssignment = { assignmentType: 'group', userId: targetUserId, groupId, createdAt: now }
  await dynamo.send(new PutCommand({
    TableName: config.dynamo.roleAssignmentsTable,
    Item: { pk, sk: `GROUP#${groupId}`, ...assignment },
  }))
  logger.info('Group assigned', { requestId: c.get('requestId'), orgId, targetUserId, groupId })
  await auditWriter(c)({
    resourceType: 'groupAssignment',
    action: 'groupAssignment:create',
    after: { userId: targetUserId, userEmail: targetUserEmail, groupId, groupName: group.name },
  })
  return ok(c, { roleAssignment: assignment }, 201)
})

// DELETE /api/v1/users/:userId/role-assignments/role/:roleId — unassign a direct role
roleAssignments.delete('/:userId/role-assignments/role/:roleId', requirePermission('org:manage-roles'), async (c) => {
  const orgId = c.get('orgId')
  const targetUserId = c.req.param('userId')
  const roleId = c.req.param('roleId')
  const key = { pk: `ORG#${orgId}#USER#${targetUserId}`, sk: `ROLE#${roleId}` }

  const [existingRes, targetUserRes, roleRes] = await Promise.all([
    dynamo.send(new GetCommand({ TableName: config.dynamo.roleAssignmentsTable, Key: key })),
    dynamo.send(new GetCommand({ TableName: config.dynamo.usersTable, Key: { userId: targetUserId } })),
    dynamo.send(new GetCommand({ TableName: config.dynamo.rolesTable, Key: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId}` } })),
  ])
  if (!existingRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Role assignment not found')
  }

  try {
    await dynamo.send(new DeleteCommand({
      TableName: config.dynamo.roleAssignmentsTable,
      Key: key,
      ConditionExpression: 'attribute_exists(sk)',
    }))
  } catch (err: unknown) {
    if (isAwsError(err) && err.name === 'ConditionalCheckFailedException') {
      return apiError(c, 'NOT_FOUND', 'Role assignment not found')
    }
    throw err
  }

  logger.info('Role unassigned', { requestId: c.get('requestId'), orgId, targetUserId, roleId })
  await auditWriter(c)({
    resourceType: 'roleAssignment',
    action: 'roleAssignment:delete',
    before: {
      userId: targetUserId,
      userEmail: (targetUserRes.Item?.['email'] as string) ?? 'unknown',
      roleId,
      roleName: (roleRes.Item?.['name'] as string) ?? 'unknown',
    },
  })
  return ok(c, { deleted: true })
})

// DELETE /api/v1/users/:userId/role-assignments/group/:groupId — unassign a group
roleAssignments.delete('/:userId/role-assignments/group/:groupId', requirePermission('org:manage-roles'), async (c) => {
  const orgId = c.get('orgId')
  const targetUserId = c.req.param('userId')
  const groupId = c.req.param('groupId')
  const key = { pk: `ORG#${orgId}#USER#${targetUserId}`, sk: `GROUP#${groupId}` }

  const [existingRes, targetUserRes, groupRes] = await Promise.all([
    dynamo.send(new GetCommand({ TableName: config.dynamo.roleAssignmentsTable, Key: key })),
    dynamo.send(new GetCommand({ TableName: config.dynamo.usersTable, Key: { userId: targetUserId } })),
    dynamo.send(new GetCommand({ TableName: config.dynamo.groupsTable, Key: { pk: `ORG#${orgId}`, sk: `GROUP#${groupId}` } })),
  ])
  if (!existingRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Group assignment not found')
  }

  try {
    await dynamo.send(new DeleteCommand({
      TableName: config.dynamo.roleAssignmentsTable,
      Key: key,
      ConditionExpression: 'attribute_exists(sk)',
    }))
  } catch (err: unknown) {
    if (isAwsError(err) && err.name === 'ConditionalCheckFailedException') {
      return apiError(c, 'NOT_FOUND', 'Group assignment not found')
    }
    throw err
  }

  logger.info('Group unassigned', { requestId: c.get('requestId'), orgId, targetUserId, groupId })
  await auditWriter(c)({
    resourceType: 'groupAssignment',
    action: 'groupAssignment:delete',
    before: {
      userId: targetUserId,
      userEmail: (targetUserRes.Item?.['email'] as string) ?? 'unknown',
      groupId,
      groupName: (groupRes.Item?.['name'] as string) ?? 'unknown',
    },
  })
  return ok(c, { deleted: true })
})

export { roleAssignments as roleAssignmentsRouter }
