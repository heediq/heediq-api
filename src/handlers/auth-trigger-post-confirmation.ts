import type { PostConfirmationTriggerHandler } from 'aws-lambda'
import { QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

const USERS_TABLE = requireEnv('USERS_TABLE_NAME')
const USER_AUTH_METHODS_TABLE = requireEnv('USER_AUTH_METHODS_TABLE_NAME')
const AUTH_AUDIT_LOG_TABLE = requireEnv('AUTH_AUDIT_LOG_TABLE_NAME')

function isAwsError(err: unknown): err is { name: string } {
  return typeof err === 'object' && err !== null && 'name' in err
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

// Fires once, right after a Cognito user (native or federated) confirms sign-up. Records which
// method this account first authenticated with — the `users` row itself is seeded lazily by the
// PreTokenGeneration trigger (auth-provision.ts) at first login, not here, so a row may not exist
// yet; `by-email` lookup falls back to this event's own `sub` when so.
export const handler: PostConfirmationTriggerHandler = async (event) => {
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') return event

  const accountId = event.request.userAttributes['sub']
  const email = event.request.userAttributes['email']?.trim().toLowerCase()
  const identitiesAttr = event.request.userAttributes['identities']
  const username = event.userName
  const now = new Date().toISOString()

  const canonicalAccountId = (email ? await resolveAccountIdByEmail(email) : null) ?? accountId

  const providerContext = providerFromIdentitiesAttr(identitiesAttr)
  if (providerContext) {
    await upsertAuthMethod(canonicalAccountId, providerContext.providerName, providerContext.providerSub, username)
  } else {
    // No `identities` claim means this is a native (email/password) confirmation.
    await upsertAuthMethod(canonicalAccountId, 'COGNITO', canonicalAccountId, username)
  }

  await dynamo.send(new PutCommand({
    TableName: AUTH_AUDIT_LOG_TABLE,
    Item: {
      pk: `USER#${canonicalAccountId}`,
      sk: `EVENT#${now}`,
      action: 'POST_CONFIRMATION_SIGNUP',
      provider: providerContext?.providerName ?? 'COGNITO',
      createdAt: now,
      details: 'Signup confirmed',
    },
  }))

  return event
}
