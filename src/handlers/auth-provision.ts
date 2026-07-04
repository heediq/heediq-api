import { randomUUID } from 'node:crypto'
import type { PreTokenGenerationTriggerHandler } from 'aws-lambda'
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import type { OrgRole } from '@heediq/shared'

// Separate Lambda entry point (own env vars, not the full API config) — this fires on every
// Cognito token issuance (D-077) and must stay minimal and fast (5s trigger timeout).
function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

const ORGS_TABLE = requireEnv('ORGS_TABLE_NAME')
const USERS_TABLE = requireEnv('USERS_TABLE_NAME')

export const handler: PreTokenGenerationTriggerHandler = async (event) => {
  const userId = event.request.userAttributes['sub']
  const email = event.request.userAttributes['email']

  const existing = await dynamo.send(
    new GetCommand({ TableName: USERS_TABLE, Key: { userId } }),
  )

  let orgId: string
  let role: OrgRole

  if (existing.Item) {
    orgId = existing.Item['orgId'] as string
    role = existing.Item['role'] as OrgRole
  } else {
    // First login for this identity (native or federated — PreTokenGeneration fires for both,
    // unlike PostConfirmation, D-077). Provisions a brand-new org with this user as admin.
    // D-020's email-domain "request to join" flow is not yet built — every first-time user
    // gets their own org rather than joining one matching their email domain.
    orgId = randomUUID()
    role = 'admin'
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
        Item: { userId, orgId, email, role, createdAt: now },
      })),
    ])
  }

  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        'custom:orgId': orgId,
        'custom:role': role,
      },
    },
  }

  return event
}
