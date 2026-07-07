import type { PostConfirmationTriggerHandler } from 'aws-lambda'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import { resolveAccountIdBySub, resolveAccountIdByEmail } from '../lib/accountIdentity.js'
import { createLogger } from '@heediq/shared'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

const USERS_TABLE = requireEnv('USERS_TABLE_NAME')
const USER_AUTH_METHODS_TABLE = requireEnv('USER_AUTH_METHODS_TABLE_NAME')
const AUTH_AUDIT_LOG_TABLE = requireEnv('AUTH_AUDIT_LOG_TABLE_NAME')
const IDENTITIES_TABLE = requireEnv('COGNITO_IDENTITIES_TABLE_NAME')
const logger = createLogger('heediq-api')

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

// Fires once, right after a Cognito user (native or federated) confirms sign-up — before the
// PreTokenGeneration trigger (auth-provision.ts) has run, so for a genuinely new signup no
// accountId exists yet to write under (D-099: accountId is a fresh app-owned id, not this
// event's `sub`, so guessing `sub` here would silently orphan the record under a key
// auth-provision.ts will never use). Only write when an existing account can be positively
// resolved (an already-linked identity, or an email match for a pre-existing account); a
// genuinely new account's initial auth method + audit entry are instead recorded by
// auth-provision.ts at first login, once the real accountId is known.
export const handler: PostConfirmationTriggerHandler = async (event) => {
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') return event

  const sub = event.request.userAttributes['sub']
  const email = event.request.userAttributes['email']?.trim().toLowerCase()
  const identitiesAttr = event.request.userAttributes['identities']
  const username = event.userName
  const now = new Date().toISOString()

  const canonicalAccountId =
    (await resolveAccountIdBySub(IDENTITIES_TABLE, sub)) ??
    (email ? await resolveAccountIdByEmail(USERS_TABLE, email) : undefined)

  if (!canonicalAccountId) {
    logger.info('No existing account for this signup — initial auth method recorded at first login instead', { sub })
    return event
  }

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

  logger.info('Signup confirmed — auth method recorded', {
    accountId: canonicalAccountId,
    provider: providerContext?.providerName ?? 'COGNITO',
  })
  return event
}
