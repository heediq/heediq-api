import type { PostAuthenticationTriggerHandler } from 'aws-lambda'
import { QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminLinkProviderForUserCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider'
import { dynamo } from '../lib/dynamo.js'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

const USERS_TABLE = requireEnv('USERS_TABLE_NAME')
const USER_AUTH_METHODS_TABLE = requireEnv('USER_AUTH_METHODS_TABLE_NAME')
const AUTH_AUDIT_LOG_TABLE = requireEnv('AUTH_AUDIT_LOG_TABLE_NAME')

const cognito = new CognitoIdentityProviderClient({})

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

async function resolveAccountIdByEmail(email: string): Promise<string | null> {
  const result = await dynamo.send(new QueryCommand({
    TableName: USERS_TABLE,
    IndexName: 'by-email',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: { ':email': email },
    Limit: 1,
  }))
  return (result.Items?.[0]?.['userId'] as string | undefined) ?? null
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

// Fires on every successful sign-in. Two jobs: (1) record this session's auth method if it's
// federated and not yet recorded, and (2) if the user signed in via a provider that isn't yet
// linked to their native/canonical account, auto-link it now — a safety net for cases the
// PreSignUp trigger's proactive link couldn't resolve at signup time (e.g. the native account
// didn't exist yet then).
export const handler: PostAuthenticationTriggerHandler = async (event) => {
  if (event.triggerSource !== 'PostAuthentication_Authentication') return event

  const userPoolId = event.userPoolId
  const accountSub = event.request.userAttributes['sub']
  const email = event.request.userAttributes['email']?.trim().toLowerCase()
  const identitiesAttr = event.request.userAttributes['identities']
  const username = event.userName
  if (!accountSub) return event

  const existingAccountId = email ? await resolveAccountIdByEmail(email) : null
  let canonicalAccountId = existingAccountId ?? accountSub

  const usersByEmail = email
    ? (await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Filter: `email = "${email}"`, Limit: 10 }))).Users ?? []
    : []
  const nativeUser = usersByEmail.find((u) => !isExternalProviderUser(u))
  if (nativeUser && !existingAccountId) {
    const nativeSub = getUserAttribute(nativeUser, 'sub')
    if (nativeSub) canonicalAccountId = nativeSub
  }

  const currentUsers = (await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Filter: `sub = "${accountSub}"`, Limit: 1 }))).Users ?? []
  const currentUser = currentUsers[0]
  const currentIsExternal = currentUser ? isExternalProviderUser(currentUser) : false

  let providerContext = currentIsExternal ? providerFromIdentitiesAttr(identitiesAttr) : null
  if (currentIsExternal && !providerContext && currentUser) {
    providerContext = providerFromIdentitiesAttr(getUserAttribute(currentUser, 'identities'))
  }

  if (currentIsExternal && !providerContext) {
    await putAudit(canonicalAccountId, 'POST_AUTH_PROVIDER_CONTEXT_MISSING', 'UNKNOWN', 'External-provider login had no resolvable identities payload')
    return event
  }

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
  } catch (err: unknown) {
    if (!isAwsError(err)) throw err
    if (err.name !== 'InvalidParameterException' && err.name !== 'ResourceConflictException') throw err
    // Already linked or a benign conflict — nothing more to do.
  }

  return event
}
