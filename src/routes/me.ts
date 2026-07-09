import { Hono } from 'hono'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import { apiError, ok } from '../lib/errors.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import { UserSchema, OrgSchema } from '@heediq/shared'

const me = new Hono<AuthContext>()

me.get('/', async (c) => {
  const userId = c.get('userId')
  const orgId = c.get('orgId')

  const [userRes, orgRes] = await Promise.all([
    dynamo.send(new GetCommand({ TableName: config.dynamo.usersTable, Key: { userId } })),
    dynamo.send(new GetCommand({ TableName: config.dynamo.orgsTable, Key: { orgId } })),
  ])

  if (!userRes.Item || !orgRes.Item) {
    return apiError(c, 'NOT_FOUND', 'User or org not found')
  }

  return ok(c, {
    user: UserSchema.parse(userRes.Item),
    org: OrgSchema.parse(orgRes.Item),
    // D-102/D-105: the server-resolved permission set, already parsed by authMiddleware from the
    // custom:permissions JWT claim — the frontend's only source of authority for usePermissions/<Can>,
    // never a client-side JWT decode.
    effectivePermissions: c.get('permissions'),
  })
})

export { me as meRouter }
