import { Hono } from 'hono'
import type { Context } from 'hono'
import { getConnInfo } from 'hono/aws-lambda'
import { QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import { resolveAccountIdBySub, resolveAccountIdByEmail, linkIdentity } from '../lib/accountIdentity.js'
import { apiError, ok } from '../lib/errors.js'
import { config } from '../config.js'
import { LookupEmailRequestSchema, LinkStartRequestSchema, LinkVerifyOtpRequestSchema, LinkConfirmRequestSchema, UserSchema, createLogger, isPasswordPolicyCompliant } from '@heediq/shared'
import type { RequestIdContext } from '../middleware/request-id.js'
import { checkRateLimit } from '../lib/rateLimit.js'
import {
  signUp,
  resendConfirmationCode,
  confirmSignUp,
  adminSetUserPassword,
  adminLinkProviderForUser,
  adminDeleteUser,
  listUsersByEmail,
  isExternalProviderUser,
  getProviderContext,
  getUserAttribute,
  randomPassword,
} from '../lib/cognito.js'

const auth = new Hono<RequestIdContext>()
const logger = createLogger('heediq-api')

function isAwsError(err: unknown): err is { name: string } {
  return typeof err === 'object' && err !== null && 'name' in err
}

async function resolveCanonicalAccountId(sub: string, email: string, fallbackSub: string): Promise<string> {
  const accountId =
    (await resolveAccountIdBySub(config.dynamo.cognitoIdentitiesTable, sub)) ??
    (await resolveAccountIdByEmail(config.dynamo.usersTable, email))
  return accountId ?? fallbackSub
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

async function isPasswordSetForEmail(email: string): Promise<boolean> {
  const result = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.usersTable,
    IndexName: 'by-email',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: { ':email': email },
    Limit: 1,
  }))
  const item = result.Items?.[0]
  if (!item) return false
  return UserSchema.parse(item).passwordSet === true
}

// A native Cognito user already exists for this email — either mid-flow (UNCONFIRMED, just
// needs a fresh code) or stuck CONFIRMED-but-never-linked (D-096: the code was verified via
// /link/verify-otp but /link/confirm's AdminSetUserPassword never ran, e.g. the user abandoned
// the flow between D-089's two screens). Cognito refuses to ever resend a code to a CONFIRMED
// user, so a stuck account has no self-service way back in — heal it by deleting the orphaned
// native user and re-running SignUp so a fresh code goes out. A CONFIRMED user whose password
// *is* set is a real, already-linked account — left untouched, same non-disclosing fallback as
// before. Returns true if the caller should respond RATE_LIMITED.
async function handleExistingNativeUser(email: string, requestId: string | undefined): Promise<boolean> {
  const users = await listUsersByEmail(email)
  const nativeUser = users.find((u) => !isExternalProviderUser(u))
  const stuck = nativeUser?.UserStatus === 'CONFIRMED' && !(await isPasswordSetForEmail(email))

  if (stuck && nativeUser?.Username) {
    logger.warn('Healing stuck confirmed-but-unlinked native user', { requestId })
    await adminDeleteUser(nativeUser.Username)
    try {
      await signUp(email, randomPassword())
    } catch (err: unknown) {
      if (isAwsError(err) && err.name === 'LimitExceededException') return true
      throw err
    }
    return false
  }

  try {
    await resendConfirmationCode(email)
  } catch (resendErr: unknown) {
    if (isAwsError(resendErr) && resendErr.name === 'LimitExceededException') return true
    // Swallow other resend failures too (e.g. already CONFIRMED with password set — a real
    // existing account, D-078 non-disclosure) — still respond success.
  }
  return false
}

// D-097 — app-level throttling for the two unauthenticated OTP endpoints, keyed by email
// *and* IP. Email-side is deliberately generous (an attacker looping this deliberately to
// lock out a real user would need a sustained, easily-noticed pattern); IP-side is tighter
// since one caller hammering the route from a single IP has no legitimate reason to. Either
// key tripping returns the identical RATE_LIMITED shape as Cognito's own LimitExceededException
// (D-078 non-disclosure — the caller never learns which layer or key blocked them).
function getClientIp(c: Context): string {
  // getConnInfo reads the Lambda event's requestContext — absent outside a real API Gateway
  // invocation (local dev, tests), so fall back rather than let the route 500.
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

async function isOtpRateLimited(c: Context, route: string, email: string): Promise<boolean> {
  const ip = getClientIp(c)
  const [emailLimited, ipLimited] = await Promise.all([
    checkRateLimit(route, 'EMAIL', email, 5, 900),
    checkRateLimit(route, 'IP', ip, 10, 60),
  ])
  return emailLimited || ipLimited
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

  if (await isOtpRateLimited(c, 'REQUEST_OTP', email)) {
    logger.warn('OTP request rate-limited', { requestId: c.get('requestId') })
    return apiError(c, 'RATE_LIMITED', 'Too many attempts — try again shortly')
  }

  try {
    await signUp(email, randomPassword())
  } catch (err: unknown) {
    if (!isAwsError(err)) throw err
    if (err.name === 'LimitExceededException') {
      logger.warn('OTP request rate-limited', { requestId: c.get('requestId') })
      return apiError(c, 'RATE_LIMITED', 'Too many attempts — try again shortly')
    }
    // A native Cognito user already exists (e.g. mid-confirmation, already fully set up, or
    // stuck confirmed-but-never-linked per D-096) — fall through to handleExistingNativeUser
    // rather than erroring, so the response shape never differs based on account state.
    if (err.name === 'UsernameExistsException' || err.name === 'InvalidParameterException' || err.name === 'AliasExistsException') {
      const rateLimited = await handleExistingNativeUser(email, c.get('requestId'))
      if (rateLimited) {
        logger.warn('OTP resend rate-limited', { requestId: c.get('requestId') })
        return apiError(c, 'RATE_LIMITED', 'Too many attempts — try again shortly')
      }
    }
  }

  logger.info('OTP sent for account link/verify', { requestId: c.get('requestId') })
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

  if (await isOtpRateLimited(c, 'VERIFY_OTP', email)) {
    logger.warn('OTP verify rate-limited', { requestId: c.get('requestId') })
    return apiError(c, 'RATE_LIMITED', 'Too many attempts — try again shortly')
  }

  try {
    await confirmSignUp(email, code)
  } catch (err: unknown) {
    if (!isAwsError(err)) throw err
    // Cognito's ConfirmSignUp checks the user's status before the code — any user that
    // isn't UNCONFIRMED (an already-set-up native account, or an email alias resolving to
    // an EXTERNAL_PROVIDER user) throws NotAuthorizedException regardless of what code was
    // submitted. Treating that as "already confirmed, proceed" let anyone bypass the code
    // entirely for any existing account by just knowing its email — always reject instead.
    logger.warn('OTP verification rejected', { requestId: c.get('requestId'), errName: err.name })
    return apiError(c, 'BAD_REQUEST', 'Invalid or expired verification code')
  }

  logger.info('OTP verified', { requestId: c.get('requestId') })
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

  // Pre-check against the shared policy (D-094) so an obviously-weak password is rejected
  // without a round trip to Cognito — the frontend already runs the same check live, but the
  // server can't trust that, so it re-checks before any Cognito call.
  if (!isPasswordPolicyCompliant(newPassword)) {
    logger.warn('Password link rejected — weak password (pre-check)', { requestId: c.get('requestId') })
    return apiError(c, 'WEAK_PASSWORD', 'Password does not meet the requirements')
  }

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
      logger.warn('Password link rejected — weak password', { requestId: c.get('requestId') })
      return apiError(c, 'WEAK_PASSWORD', 'Password does not meet the requirements')
    }
    logger.error('Failed to set password during account link', { requestId: c.get('requestId') })
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
        logger.warn('Account link confirm rejected — already linked to another user', { requestId: c.get('requestId') })
        return apiError(c, 'CONFLICT', 'This account is already linked to another user')
      }
      throw err
    }
  }

  const nativeSub = getUserAttribute(nativeUser, 'sub') ?? nativeUser.Username
  const canonicalAccountId = await resolveCanonicalAccountId(nativeSub, email, nativeSub)
  // Pin the native identity to its canonical accountId now (D-099) — this is the sub every
  // future login (native, and any provider linked above via AdminLinkProviderForUser) will
  // present, so PreTokenGeneration resolves it deterministically instead of re-guessing by email.
  await linkIdentity(config.dynamo.cognitoIdentitiesTable, nativeSub, canonicalAccountId)
  await recordAuthMethodAndAudit(canonicalAccountId, nativeUser.Username)

  logger.info('Password set and providers linked', { requestId: c.get('requestId'), accountId: canonicalAccountId })
  return ok(c, { passwordSet: true })
})

export { auth as authRouter }
