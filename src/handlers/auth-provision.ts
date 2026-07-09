import { randomUUID } from 'node:crypto'
import type { PreTokenGenerationTriggerHandler } from 'aws-lambda'
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import { resolveAccountIdBySub, resolveAccountIdByEmail, linkIdentity } from '../lib/accountIdentity.js'
import { ensureOrgRbacSeeded, ensureUserRoleAssignment, resolveEffectivePermissions, type RbacTables } from '../lib/rbac.js'
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
const IDENTITIES_TABLE = requireEnv('COGNITO_IDENTITIES_TABLE_NAME')
const USER_AUTH_METHODS_TABLE = requireEnv('USER_AUTH_METHODS_TABLE_NAME')
const AUTH_AUDIT_LOG_TABLE = requireEnv('AUTH_AUDIT_LOG_TABLE_NAME')
const RBAC_TABLES: RbacTables = {
  rolesTable: requireEnv('ROLES_TABLE_NAME'),
  groupsTable: requireEnv('GROUPS_TABLE_NAME'),
  roleAssignmentsTable: requireEnv('ROLE_ASSIGNMENTS_TABLE_NAME'),
}
const logger = createLogger('heediq-api')

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

export const handler: PreTokenGenerationTriggerHandler = async (event) => {
  const sub = event.request.userAttributes['sub']
  const email = event.request.userAttributes['email']?.trim().toLowerCase()

  // Deterministic path (D-099): every sub this identity has ever logged in with is mapped to
  // one accountId once, up front — no re-guessing on every login.
  let accountId = await resolveAccountIdBySub(IDENTITIES_TABLE, sub)

  if (accountId) {
    const user = await dynamo.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId: accountId } }))
    if (user.Item) {
      const orgId = user.Item['orgId'] as string
      const permissions = await resolveEffectivePermissions(RBAC_TABLES, orgId, accountId)
      logger.info('Existing user resolved via identities table', { sub, accountId })
      event.response = {
        claimsOverrideDetails: {
          claimsToAddOrOverride: {
            'custom:accountId': accountId,
            'custom:orgId': orgId,
            'custom:role': user.Item['role'] as OrgRole,
            // JSON-stringified Permission[] (D-105) — baked in at token issuance, same
            // trust model as custom:role; refreshed on every token refresh, no per-request
            // DB read on the request path.
            'custom:permissions': JSON.stringify(permissions),
          },
        },
      }
      return event
    }
    // Mapping existed but the user row is gone — fall through and self-heal below.
    accountId = undefined
  }

  // Self-heal (D-090): no identity mapping yet, e.g. a sub that logged in before D-099, or a
  // sub freshly repointed by AdminLinkProviderForUser onto an account it hasn't mapped yet.
  // The email guess is provisional — resolving it pins a definitive mapping for this sub below
  // so every subsequent login for this sub takes the deterministic path.
  const existingAccountId = await resolveAccountIdByEmail(USERS_TABLE, email)

  if (existingAccountId) {
    const user = await dynamo.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId: existingAccountId } }))
    if (user.Item) {
      const orgId = user.Item['orgId'] as string
      const [, permissions] = await Promise.all([
        linkIdentity(IDENTITIES_TABLE, sub, existingAccountId),
        resolveEffectivePermissions(RBAC_TABLES, orgId, existingAccountId),
      ])
      logger.info('Existing user resolved and identity linked via email self-heal', { sub, accountId: existingAccountId })
      event.response = {
        claimsOverrideDetails: {
          claimsToAddOrOverride: {
            'custom:accountId': existingAccountId,
            'custom:orgId': orgId,
            'custom:role': user.Item['role'] as OrgRole,
            'custom:permissions': JSON.stringify(permissions),
          },
        },
      }
      return event
    }
  }

  // Genuinely first login for this email (native or federated — PreTokenGeneration fires for
  // both, unlike PostConfirmation, D-077). Provisions a brand-new org with this user as admin,
  // a new app-owned accountId (D-099), and the first identity mapping for it.
  // D-020's email-domain "request to join" flow is not yet built — every first-time user gets
  // their own org rather than joining one matching their email domain.
  const newAccountId = randomUUID()
  const orgId = randomUUID()
  const role: OrgRole = 'admin'
  const now = new Date().toISOString()
  const emailDomain = email.split('@')[1] ?? ''

  // The first auth method + audit entry are recorded here, not in the PostConfirmation trigger
  // (auth-trigger-post-confirmation.ts): PostConfirmation fires before this accountId exists, so
  // under D-099's decoupled accountId it can no longer guess the right key to write under.
  const providerContext = providerFromIdentitiesAttr(event.request.userAttributes['identities'])
  const providerName = providerContext?.providerName ?? 'COGNITO'
  const providerSub = providerContext?.providerSub ?? sub

  // Seeds admin/member system roles for the new org (D-102) — must complete before the role
  // assignment below, which references the seeded admin roleId.
  const seededRoles = await ensureOrgRbacSeeded(RBAC_TABLES, orgId)

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
      Item: { userId: newAccountId, orgId, email, role, passwordSet: !isFederatedLogin(event), createdAt: now },
    })),
    linkIdentity(IDENTITIES_TABLE, sub, newAccountId),
    dynamo.send(new PutCommand({
      TableName: USER_AUTH_METHODS_TABLE,
      Item: {
        pk: `USER#${newAccountId}`,
        sk: `METHOD#${providerName.toUpperCase()}`,
        provider: providerName,
        providerSub,
        linkedAt: now,
        verified: true,
        username: sub,
      },
    })),
    dynamo.send(new PutCommand({
      TableName: AUTH_AUDIT_LOG_TABLE,
      Item: {
        pk: `USER#${newAccountId}`,
        sk: `EVENT#${now}`,
        action: 'FIRST_LOGIN_PROVISIONED',
        provider: providerName,
        createdAt: now,
        details: 'New org and account provisioned at first login',
      },
    })),
    ensureUserRoleAssignment(RBAC_TABLES, orgId, newAccountId, seededRoles.admin.roleId),
  ])

  logger.info('New org provisioned at first login', { sub, accountId: newAccountId, orgId, federated: isFederatedLogin(event) })
  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        'custom:accountId': newAccountId,
        'custom:orgId': orgId,
        'custom:role': role,
        // Admin gets every permission by seed definition (D-102) — no need to re-resolve via
        // a role-assignment query right after writing it.
        'custom:permissions': JSON.stringify(seededRoles.admin.permissions),
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
