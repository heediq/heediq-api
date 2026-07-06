import { randomUUID } from 'node:crypto'
import type { PreTokenGenerationTriggerHandler } from 'aws-lambda'
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import { createLogger, type OrgRole } from '@heediq/shared'

// Separate Lambda entry point (own env vars, not the full API config) — this fires on every
// Cognito token issuance (D-077) and must stay minimal and fast (5s trigger timeout).
function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

const ORGS_TABLE = requireEnv('ORGS_TABLE_NAME')
const USERS_TABLE = requireEnv('USERS_TABLE_NAME')
const logger = createLogger('heediq-api')

export const handler: PreTokenGenerationTriggerHandler = async (event) => {
  const userId = event.request.userAttributes['sub']
  const email = event.request.userAttributes['email']?.trim().toLowerCase()

  // Resolve the canonical row by email first, not by sub (D-090). After AdminLinkProviderForUser
  // links a federated identity to a native user (D-089), that identity's subsequent logins present
  // the native user's sub, not the sub that originally created this row — a sub-only lookup would
  // miss and re-provision a duplicate org for the same email.
  const existing = await resolveExistingUser(userId, email)

  if (!existing) {
    // First login for this identity (native or federated — PreTokenGeneration fires for both,
    // unlike PostConfirmation, D-077). Provisions a brand-new org with this user as admin.
    // D-020's email-domain "request to join" flow is not yet built — every first-time user
    // gets their own org rather than joining one matching their email domain.
    const orgId = randomUUID()
    const role: OrgRole = 'admin'
    const now = new Date().toISOString()
    const emailDomain = email.split('@')[1] ?? ''

    await Promise.all([
      dynamo.send(new PutCommand({
        TableName: ORGS_TABLE,
        Item: {
          orgId,
          name: email.split('@')[0],
          plan: 'free',
          seatCount: 1,
          usageLifetimeCount: 0,
          emailDomain,
          createdAt: now,
        },
      })),
      dynamo.send(new PutCommand({
        TableName: USERS_TABLE,
        // passwordSet tracks whether this identity has a Cognito password credential — this
        // Lambda only ever fires for logins that already succeeded, so a federated-only login
        // here has no password yet; a native email/password signup does (D-078).
        Item: { userId, orgId, email, role, passwordSet: !isFederatedLogin(event), createdAt: now },
      })),
    ])

    logger.info('New org provisioned at first login', { userId, orgId, federated: isFederatedLogin(event) })
    event.response = {
      claimsOverrideDetails: {
        claimsToAddOrOverride: { 'custom:orgId': orgId, 'custom:role': role },
      },
    }
    return event
  }

  logger.info('Existing user resolved at login', { userId, orgId: existing['orgId'] })
  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        'custom:orgId': existing['orgId'] as string,
        'custom:role': existing['role'] as OrgRole,
      },
    },
  }

  return event
}

// Cognito populates `sub` with the IdP-qualified identifier ("Google_1234...") for federated
// sign-ins and a plain UUID for native ones — this is the standard way to tell them apart
// without needing to inspect Client Metadata or the trigger source.
function isFederatedLogin(event: Parameters<PreTokenGenerationTriggerHandler>[0]): boolean {
  return event.request.userAttributes['identities'] !== undefined
}

async function resolveExistingUser(
  userId: string,
  email: string,
): Promise<Record<string, unknown> | undefined> {
  const byEmail = await dynamo.send(new QueryCommand({
    TableName: USERS_TABLE,
    IndexName: 'by-email',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: { ':email': email },
    Limit: 1,
  }))
  if (byEmail.Items?.[0]) return byEmail.Items[0]

  const bySub = await dynamo.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } }))
  return bySub.Item
}
