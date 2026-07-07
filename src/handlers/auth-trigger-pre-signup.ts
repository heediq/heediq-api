import type { PreSignUpTriggerHandler } from 'aws-lambda'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminCreateUserCommand,
  AdminLinkProviderForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { dynamo } from '../lib/dynamo.js'
import { resolveAccountIdByEmail } from '../lib/accountIdentity.js'
import { createLogger } from '@heediq/shared'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

const USERS_TABLE = requireEnv('USERS_TABLE_NAME')
const USER_AUTH_METHODS_TABLE = requireEnv('USER_AUTH_METHODS_TABLE_NAME')

const cognito = new CognitoIdentityProviderClient({})
const logger = createLogger('heediq-api')

function isAwsError(err: unknown): err is { name: string } {
  return typeof err === 'object' && err !== null && 'name' in err
}

// Federated usernames are `<ProviderName>_<providerUserId>` (D-020's two configured IdPs).
const PROVIDER_PREFIXES: Record<string, string> = { google: 'Google', microsoft: 'Microsoft' }

function providerNameFromUsername(username: string): string | null {
  const idx = username.indexOf('_')
  if (idx < 0) return null
  return PROVIDER_PREFIXES[username.slice(0, idx).toLowerCase()] ?? null
}

function providerSubjectFromUsername(username: string): string | null {
  const idx = username.indexOf('_')
  return idx < 0 ? null : username.slice(idx + 1)
}

function randomTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let core = ''
  for (let i = 0; i < 20; i++) core += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `Aa9!${core}`
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

async function findDestinationUsername(userPoolId: string, email: string): Promise<string | null> {
  const result = await cognito.send(new ListUsersCommand({
    UserPoolId: userPoolId,
    Filter: `email = "${email}"`,
    Limit: 5,
  }))
  const users = result.Users ?? []
  if (users.length === 0) return null
  const native = users.find((u) => !(u.Username ?? '').includes('_'))
  return (native ?? users[0])?.Username ?? null
}

async function autoHealNativeUser(userPoolId: string, email: string): Promise<string> {
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
      TemporaryPassword: randomTemporaryPassword(),
      MessageAction: 'SUPPRESS',
    }))
    return email
  } catch (err: unknown) {
    if (isAwsError(err) && err.name === 'UsernameExistsException') return email
    throw err
  }
}

// Fires only for federated (Google/Microsoft) sign-ins. Links the new external identity onto
// an existing native/DynamoDB account for the same email immediately — no OTP step, since the
// IdP has already asserted email ownership (this is the "proactive linking" half of D-078;
// D-087's OTP flow is for the reverse direction, linking a provider onto a password account).
export const handler: PreSignUpTriggerHandler = async (event) => {
  if (event.triggerSource !== 'PreSignUp_ExternalProvider') return event

  const userPoolId = event.userPoolId
  const email = event.request.userAttributes['email']?.trim().toLowerCase()
  const providerName = providerNameFromUsername(event.userName)
  const providerSub = providerSubjectFromUsername(event.userName) ?? event.request.userAttributes['sub']

  if (!email) {
    throw new Error(`We were not able to get your email from ${providerName ?? 'the social provider'} — please try again or use another login option.`)
  }
  if (!providerName || !providerSub) {
    throw new Error('Unable to resolve social provider identity, please try again.')
  }

  const accountId = await resolveAccountIdByEmail(USERS_TABLE, email)
  let destinationUsername = await findDestinationUsername(userPoolId, email)
  if (!destinationUsername && accountId) {
    destinationUsername = await autoHealNativeUser(userPoolId, email)
    logger.info('Auto-healed native user for proactive link', { accountId, providerName })
  }
  if (!destinationUsername) {
    // No existing account for this email — Cognito creates the external-provider user as new.
    logger.info('No existing account to link — new external-provider user', { providerName })
    return event
  }

  try {
    await cognito.send(new AdminLinkProviderForUserCommand({
      UserPoolId: userPoolId,
      DestinationUser: { ProviderName: 'Cognito', ProviderAttributeValue: destinationUsername },
      SourceUser: { ProviderName: providerName, ProviderAttributeName: 'Cognito_Subject', ProviderAttributeValue: providerSub },
    }))
  } catch (err: unknown) {
    if (!isAwsError(err)) throw err
    if (err.name === 'AliasExistsException' || err.name === 'ResourceConflictException') {
      logger.warn('Proactive link rejected — email already linked to another account', { accountId, providerName, errName: err.name })
      throw new Error('This email is already linked to another account. Use your original sign-in method or contact support.')
    }
    if (err.name === 'InvalidParameterException') {
      // Already linked to this same destination from a repeat flow — continue.
      if (accountId) await upsertAuthMethod(accountId, providerName, providerSub, event.userName)
      return event
    }
    throw err
  }

  logger.info('Proactively linked external provider to native account', { accountId, providerName })
  if (accountId) await upsertAuthMethod(accountId, providerName, providerSub, event.userName)
  return event
}
