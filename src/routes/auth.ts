import { Hono } from 'hono'
import { QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import { apiError, ok } from '../lib/errors.js'
import { config } from '../config.js'
import { LookupEmailRequestSchema, LinkStartRequestSchema, LinkVerifyOtpRequestSchema, LinkConfirmRequestSchema, UserSchema } from '@heediq/shared'
import {
  signUp,
  resendConfirmationCode,
  confirmSignUp,
  adminSetUserPassword,
  adminLinkProviderForUser,
  listUsersByEmail,
  isExternalProviderUser,
  getProviderContext,
  getUserAttribute,
  randomPassword,
} from '../lib/cognito.js'

const auth = new Hono()

function isAwsError(err: unknown): err is { name: string } {
  return typeof err === 'object' && err !== null && 'name' in err
}

async function resolveCanonicalAccountId(email: string, fallbackSub: string): Promise<string> {
  const result = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.usersTable,
    IndexName: 'by-email',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: { ':email': email },
    Limit: 1,
  }))
  const userId = result.Items?.[0]?.['userId'] as string | undefined
  return userId ?? fallbackSub
}

async function recordAuthMethodAndAudit(accountId: string, username: string) {
  const now = new Date().toISOString()
  await dynamo.send(new PutCommand({
    TableName: config.dynamo.userAuthMethodsTable,
    Item: { pk: `USER#${accountId}`, sk: 'METHOD#COGNITO', provider: 'COGNITO', username, linkedAt: now },
    ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
  })).catch((err: unknown) => {
    if (!isAwsError(err) || err.name !== 'ConditionalCheckFailedException') throw err
  })

  await dynamo.send(new PutCommand({
    TableName: config.dynamo.authAuditLogTable,
    Item: { pk: `USER#${accountId}`, sk: `EVENT#${now}`, action: 'SET_PASSWORD', provider: 'COGNITO', createdAt: now },
  }))

  // Only flips the flag on a user row that already exists (created at first federated
  // login by the PostAuthentication/PreTokenGeneration trigger) — never creates one here.
  await dynamo.send(new UpdateCommand({
    TableName: config.dynamo.usersTable,
    Key: { userId: accountId },
    UpdateExpression: 'SET passwordSet = :true',
    ConditionExpression: 'attribute_exists(userId)',
    ExpressionAttributeValues: { ':true': true },
  })).catch((err: unknown) => {
    if (!isAwsError(err) || err.name !== 'ConditionalCheckFailedException') throw err
  })
}

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

// POST /api/v1/auth/link/request-otp — unauthenticated (D-087). Kicks off Cognito's own
// SignUp/ConfirmSignUp verification-code flow to prove ownership of the email before a
// password is set and any existing federated identity is linked. Always responds success —
// never reveals whether the email is new, existing-native, or existing-federated.
auth.post('/link/request-otp', async (c) => {
  const body = await c.req.json()
  if (body && typeof body.email === 'string') {
    body.email = body.email.trim().toLowerCase()
  }
  const parsed = LinkStartRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }
  const email = parsed.data.email

  try {
    await signUp(email, randomPassword())
  } catch (err: unknown) {
    if (!isAwsError(err)) throw err
    if (err.name === 'LimitExceededException') {
      return apiError(c, 'RATE_LIMITED', 'Too many attempts — try again shortly')
    }
    // A native Cognito user already exists (e.g. mid-confirmation, or already fully set up) —
    // fall through to resending the existing code rather than erroring, so the response shape
    // never differs based on account state.
    if (err.name === 'UsernameExistsException' || err.name === 'InvalidParameterException' || err.name === 'AliasExistsException') {
      try {
        await resendConfirmationCode(email)
      } catch (resendErr: unknown) {
        if (isAwsError(resendErr) && resendErr.name === 'LimitExceededException') {
          return apiError(c, 'RATE_LIMITED', 'Too many attempts — try again shortly')
        }
        // Swallow other resend failures too (e.g. already CONFIRMED, nothing to resend) —
        // still respond success to avoid leaking account state.
      }
    }
  }

  return ok(c, { sent: true })
})

// POST /api/v1/auth/link/verify-otp — unauthenticated (D-089). Verifies the Cognito code on
// its own, before any password is collected — this is the two-step flow's actual step 1/2
// backend boundary (the code screen must not advance to the password screen without this
// round trip succeeding). The code is consumed here (Cognito's ConfirmSignUp) and is never
// sent again to /link/confirm.
auth.post('/link/verify-otp', async (c) => {
  const body = await c.req.json()
  if (body && typeof body.email === 'string') {
    body.email = body.email.trim().toLowerCase()
  }
  const parsed = LinkVerifyOtpRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }
  const { email, code } = parsed.data

  try {
    await confirmSignUp(email, code)
  } catch (err: unknown) {
    if (!isAwsError(err)) throw err
    // Cognito's ConfirmSignUp checks the user's status before the code — any user that
    // isn't UNCONFIRMED (an already-set-up native account, or an email alias resolving to
    // an EXTERNAL_PROVIDER user) throws NotAuthorizedException regardless of what code was
    // submitted. Treating that as "already confirmed, proceed" let anyone bypass the code
    // entirely for any existing account by just knowing its email — always reject instead.
    return apiError(c, 'BAD_REQUEST', 'Invalid or expired verification code')
  }

  return ok(c, { verified: true })
})

// POST /api/v1/auth/link/confirm — unauthenticated (D-087/D-089). Called only after
// /link/verify-otp has already confirmed the code — sets the real password on the native
// identity and links any existing federated identities (Google/Microsoft) for the same email
// so the user has one account reachable by all methods.
auth.post('/link/confirm', async (c) => {
  const body = await c.req.json()
  if (body && typeof body.email === 'string') {
    body.email = body.email.trim().toLowerCase()
  }
  const parsed = LinkConfirmRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }
  const { email, newPassword } = parsed.data

  const users = await listUsersByEmail(email)
  const nativeUser = users.find((u) => !isExternalProviderUser(u))
  if (!nativeUser?.Username) {
    return apiError(c, 'BAD_REQUEST', 'Account setup is incomplete — request a new code and try again')
  }

  try {
    await adminSetUserPassword(nativeUser.Username, newPassword)
  } catch (err: unknown) {
    // Cognito's own InvalidPasswordException means the password itself failed the pool's
    // policy — distinct from every other failure here, so the frontend can show a
    // requirements-specific message instead of a generic one.
    if (isAwsError(err) && err.name === 'InvalidPasswordException') {
      return apiError(c, 'WEAK_PASSWORD', 'Password does not meet the requirements')
    }
    return apiError(c, 'BAD_REQUEST', 'Failed to set password')
  }

  const externalUsers = users.filter(isExternalProviderUser)
  for (const externalUser of externalUsers) {
    const providerContext = getProviderContext(externalUser)
    if (!providerContext) continue
    try {
      await adminLinkProviderForUser(nativeUser.Username, providerContext.providerName, providerContext.providerUserId)
    } catch (err: unknown) {
      if (!isAwsError(err)) throw err
      if (err.name === 'InvalidParameterException') continue // already linked
      if (err.name === 'AliasExistsException' || err.name === 'ResourceConflictException') {
        return apiError(c, 'CONFLICT', 'This account is already linked to another user')
      }
      throw err
    }
  }

  const nativeSub = getUserAttribute(nativeUser, 'sub') ?? nativeUser.Username
  const canonicalAccountId = await resolveCanonicalAccountId(email, nativeSub)
  await recordAuthMethodAndAudit(canonicalAccountId, nativeUser.Username)

  return ok(c, { passwordSet: true })
})

export { auth as authRouter }
