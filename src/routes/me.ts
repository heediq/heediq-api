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
  })
})

export { me as meRouter }
