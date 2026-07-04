import { Hono } from 'hono'
import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import { apiError, ok } from '../lib/errors.js'
import { config } from '../config.js'
import { LookupEmailRequestSchema, UserSchema } from '@heediq/shared'

const auth = new Hono()

// POST /api/v1/auth/lookup-email — unauthenticated (D-078). Drives the unified sign-in
// screen's next step. Response never reveals which IdP an existing account uses — only
// whether the email exists and whether a password can be used to sign in.
auth.post('/lookup-email', async (c) => {
  const body = await c.req.json()
  // Normalize before validating — Zod's email() rejects surrounding whitespace, and the
  // unified sign-in screen shouldn't punish a user for a leading/trailing space or caps-lock.
  if (body && typeof body.email === 'string') {
    body.email = body.email.trim().toLowerCase()
  }
  const parsed = LookupEmailRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const email = parsed.data.email
  const result = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.usersTable,
    IndexName: 'by-email',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: { ':email': email },
    Limit: 1,
  }))

  const item = result.Items?.[0]
  if (!item) {
    return ok(c, { exists: false, passwordSet: null })
  }

  const user = UserSchema.parse(item)
  return ok(c, { exists: true, passwordSet: user.passwordSet })
})

export { auth as authRouter }
