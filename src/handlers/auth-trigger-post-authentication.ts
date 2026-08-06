import type { PostAuthenticationTriggerHandler } from 'aws-lambda'
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminLinkProviderForUserCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider'
import { dynamo } from '../lib/dynamo.js'
import { resolveAccountIdBySub, resolveAccountIdByEmail, linkIdentity } from '../lib/accountIdentity.js'
import { createLogger, AnalyticsAuthMethodSchema } from '@heediq/shared'
import { emitServerAnalytics } from '../lib/analytics.js'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

const USERS_TABLE = requireEnv('USERS_TABLE_NAME')
const USER_AUTH_METHODS_TABLE = requireEnv('USER_AUTH_METHODS_TABLE_NAME')
const AUTH_AUDIT_LOG_TABLE = requireEnv('AUTH_AUDIT_LOG_TABLE_NAME')
const IDENTITIES_TABLE = requireEnv('COGNITO_IDENTITIES_TABLE_NAME')

const cognito = new CognitoIdentityProviderClient({})
const logger = createLogger('heediq-api')

function isAwsError(err: unknown): err is { name: string } {
  return typeof err === 'object' && err !== null && 'name' in err
}

function isExternalProviderUser(user: UserType): boolean {
  return user.UserStatus === 'EXTERNAL_PROVIDER'
}

function getUserAttribute(user: UserType, name: string): string | undefined {
  return user.Attributes?.find((a) => a.Name === name)?.Value
}

function providerFromIdentitiesAttr(raw: string | undefined): { providerName: string; providerSub: string } | null {
  if (!raw) return null
  let identities: unknown
  try {
    identities = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(identities) || identities.length === 0) return null
  const first = identities[0] as { providerName?: unknown; userId?: unknown }
  if (typeof first.providerName === 'string' && typeof first.userId === 'string') {
    return { providerName: first.providerName, providerSub: first.userId }
  }
  return null
}

async function upsertAuthMethod(accountId: string, providerName: string, providerSub: string, username: string) {
  await dynamo.send(new PutCommand({
    TableName: USER_AUTH_METHODS_TABLE,
    Item: {
      pk: `USER#${accountId}`,
      sk: `METHOD#${providerName.toUpperCase()}`,
      provider: providerName,
      providerSub,
      linkedAt: new Date().toISOString(),
      verified: true,
      username,
    },
    ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
  })).catch((err: unknown) => {
    if (!isAwsError(err) || err.name !== 'ConditionalCheckFailedException') throw err
  })
}

async function putAudit(accountId: string, action: string, provider: string, details: string) {
  const now = new Date().toISOString()
  await dynamo.send(new PutCommand({
    TableName: AUTH_AUDIT_LOG_TABLE,
    Item: { pk: `USER#${accountId}`, sk: `EVENT#${now}`, action, provider, createdAt: now, details },
  }))
}

// Server-side `login_completed` (D-154): the authoritative sign-in outcome, emitted once per
// successful authentication. `method` is the provider used (native = 'password'); anything not in
// the shared auth-method enum is skipped rather than guessed. Requires the user's orgId, so it
// reads the USERS row — which for a genuinely-new user doesn't exist yet at PostAuthentication time
// (PreTokenGeneration writes it moments later), so a first login emits nothing here and is captured
// by `user_provisioned` instead. Fail-safe: emitServerAnalytics never throws / is latency-bounded.
async function emitLoginCompleted(accountId: string, method: string): Promise<void> {
  const parsed = AnalyticsAuthMethodSchema.safeParse(method)
  if (!parsed.success) return
  const user = await dynamo.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId: accountId } }))
  const orgId = user.Item?.['orgId']
  if (typeof orgId !== 'string') return
  await emitServerAnalytics({
    identity: { userId: accountId, orgId },
    type: 'login_completed',
    payload: { method: parsed.data },
  })
}

// Fires on every successful sign-in, before PreTokenGeneration (auth-provision.ts). Two jobs:
// (1) record this session's auth method if it's federated and not yet recorded, and (2) if the
// user signed in via a provider that isn't yet linked to their native/canonical account,
// auto-link it now — a safety net for cases the PreSignUp trigger's proactive link couldn't
// resolve at signup time (e.g. the native account didn't exist yet then).
//
// canonicalAccountId is resolved the same way auth-provision.ts resolves it (identities table
// first, D-099; email guess as self-heal fallback) so the auth-method/audit records this
// handler writes land under the same accountId that PreTokenGeneration will assign moments
// later — using a different resolution here was the source of a real bug where linked-account
// auth methods became invisible to `/auth/methods` (see D-099).
export const handler: PostAuthenticationTriggerHandler = async (event) => {
  if (event.triggerSource !== 'PostAuthentication_Authentication') return event

  const userPoolId = event.userPoolId
  const accountSub = event.request.userAttributes['sub']
  const email = event.request.userAttributes['email']?.trim().toLowerCase()
  const identitiesAttr = event.request.userAttributes['identities']
  const username = event.userName
  if (!accountSub) return event

  const resolvedAccountId =
    (await resolveAccountIdBySub(IDENTITIES_TABLE, accountSub)) ??
    (email ? await resolveAccountIdByEmail(USERS_TABLE, email) : undefined)

  const usersByEmail = email
    ? (await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Filter: `email = "${email}"`, Limit: 10 }))).Users ?? []
    : []
  const nativeUser = usersByEmail.find((u) => !isExternalProviderUser(u))

  // No mapping and no DynamoDB row yet, but a native Cognito user exists for this email — use
  // its sub, since that's the sub future logins through the eventually-linked provider will
  // present (AdminLinkProviderForUser below repoints them there).
  const canonicalAccountId = resolvedAccountId ?? (nativeUser ? getUserAttribute(nativeUser, 'sub') : undefined) ?? accountSub

  // Pin this sub to its resolved accountId now (D-099) so this session's PreTokenGeneration
  // call (which fires right after, for the same sub) resolves deterministically instead of
  // re-running the email guess.
  if (!resolvedAccountId) await linkIdentity(IDENTITIES_TABLE, accountSub, canonicalAccountId)

  const currentUsers = (await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Filter: `sub = "${accountSub}"`, Limit: 1 }))).Users ?? []
  const currentUser = currentUsers[0]
  const currentIsExternal = currentUser ? isExternalProviderUser(currentUser) : false

  let providerContext = currentIsExternal ? providerFromIdentitiesAttr(identitiesAttr) : null
  if (currentIsExternal && !providerContext && currentUser) {
    providerContext = providerFromIdentitiesAttr(getUserAttribute(currentUser, 'identities'))
  }

  if (currentIsExternal && !providerContext) {
    logger.warn('External-provider login had no resolvable identities payload', { accountId: canonicalAccountId })
    await putAudit(canonicalAccountId, 'POST_AUTH_PROVIDER_CONTEXT_MISSING', 'UNKNOWN', 'External-provider login had no resolvable identities payload')
    return event
  }

  // Emit login_completed once the auth method is known — native sign-ins are 'password', federated
  // ones map from the provider name. Placed before the auth-method/link bookkeeping below so it
  // fires for every successful sign-in regardless of which of those branches returns first.
  const method = currentIsExternal && providerContext ? providerContext.providerName.toLowerCase() : 'password'
  await emitLoginCompleted(canonicalAccountId, method)

  if (currentIsExternal && providerContext) {
    await upsertAuthMethod(canonicalAccountId, providerContext.providerName, providerContext.providerSub, username)
  }

  if (!(currentIsExternal && providerContext && email && nativeUser?.Username)) {
    return event
  }

  try {
    await cognito.send(new AdminLinkProviderForUserCommand({
      UserPoolId: userPoolId,
      DestinationUser: { ProviderName: 'Cognito', ProviderAttributeValue: nativeUser.Username },
      SourceUser: { ProviderName: providerContext.providerName, ProviderAttributeName: 'Cognito_Subject', ProviderAttributeValue: providerContext.providerSub },
    }))
    await putAudit(canonicalAccountId, 'AUTO_LINK_POST_AUTH', providerContext.providerName, `Linked ${providerContext.providerName} to native user ${nativeUser.Username}`)
    logger.info('Auto-linked external provider to native account post-auth', { accountId: canonicalAccountId, provider: providerContext.providerName })
  } catch (err: unknown) {
    if (!isAwsError(err)) throw err
    if (err.name !== 'InvalidParameterException' && err.name !== 'ResourceConflictException') throw err
    // Already linked or a benign conflict — nothing more to do.
  }

  return event
}
