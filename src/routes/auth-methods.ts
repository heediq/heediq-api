import { Hono } from 'hono'
import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import { ok } from '../lib/errors.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import { AuthMethodSchema, type AuthMethod } from '@heediq/shared'

// Authenticated — unlike routes/auth.ts (D-078/D-079's pre-session flows), this reads a
// signed-in user's own methods, so it's mounted under the authMiddleware-guarded group.
const authMethods = new Hono<AuthContext>()

// GET /api/v1/auth/methods — D-091. heediq-user-auth-methods is the source of truth for
// which sign-in methods are active; Cognito itself is never queried ad hoc for this.
authMethods.get('/', async (c) => {
  const userId = c.get('userId')

  const result = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.userAuthMethodsTable,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':skPrefix': 'METHOD#' },
  }))

  const methods: AuthMethod[] = (result.Items ?? []).map((item) =>
    AuthMethodSchema.parse({ provider: item['provider'], linkedAt: item['linkedAt'] }),
  )

  return ok(c, { methods })
})

export { authMethods as authMethodsRouter }
