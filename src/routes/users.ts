import { Hono } from 'hono'
import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import { ok } from '../lib/errors.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import { UserSchema, type User } from '@heediq/shared'

const users = new Hono<AuthContext>()

// GET /api/v1/users — org-scoped user list, used by the role/group assignment screen (D-102 Phase 4).
// Read-open to any authenticated org member, same posture as GET /roles and GET /groups.
users.get('/', async (c) => {
  const orgId = c.get('orgId')

  const result = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.usersTable,
    IndexName: 'by-org',
    KeyConditionExpression: 'orgId = :orgId',
    ExpressionAttributeValues: { ':orgId': orgId },
  }))

  const userList: User[] = (result.Items ?? []).map((item) => UserSchema.parse(item))

  return ok(c, { users: userList })
})

export { users as usersRouter }
