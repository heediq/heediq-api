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
// auth-provision.ts will never use). A genuinely new account's initial auth method + audit
// entry are instead recorded by auth-provision.ts at first login, once the real accountId is
// known.
//
// Only the federated-identity branch writes here. A native (no `identities` claim)
// ConfirmSignUp only proves the caller owns the email — it does not mean a password exists yet
// (`/link/request-otp` seeds the shadow user with a random password; the real one is set later
// by `/link/confirm`'s AdminSetUserPassword). Writing METHOD#COGNITO at this point previously
// caused a stuck-looking "linked but no password" state whenever the two-step OTP-then-password
// flow (D-089) was abandoned between screens — GET /auth/methods reported COGNITO as linked
// with no credential behind it. That row's only correct writer is auth.ts's
// recordAuthMethodAndAudit, called from `/link/confirm` after the password is actually set.
export const handler: PostConfirmationTriggerHandler = async (event) => {
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') return event

  const sub = event.request.userAttributes['sub']
  const email = event.request.userAttributes['email']?.trim().toLowerCase()
  const identitiesAttr = event.request.userAttributes['identities']
  const username = event.userName
  const now = new Date().toISOString()

  const providerContext = providerFromIdentitiesAttr(identitiesAttr)
  if (!providerContext) {
    logger.info('Native ConfirmSignUp — auth method recorded later, once a password is set', { sub })
    return event
  }

  const canonicalAccountId =
    (await resolveAccountIdBySub(IDENTITIES_TABLE, sub)) ??
    (email ? await resolveAccountIdByEmail(USERS_TABLE, email) : undefined)

  if (!canonicalAccountId) {
    logger.info('No existing account for this signup — initial auth method recorded at first login instead', { sub })
    return event
  }

  await upsertAuthMethod(canonicalAccountId, providerContext.providerName, providerContext.providerSub, username)

  await dynamo.send(new PutCommand({
    TableName: AUTH_AUDIT_LOG_TABLE,
    Item: {
      pk: `USER#${canonicalAccountId}`,
      sk: `EVENT#${now}`,
      action: 'POST_CONFIRMATION_SIGNUP',
      provider: providerContext.providerName,
      createdAt: now,
      details: 'Signup confirmed',
    },
  }))

  logger.info('Signup confirmed — auth method recorded', {
    accountId: canonicalAccountId,
    provider: providerContext.providerName,
  })
  return event
}
