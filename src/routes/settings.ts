import { Hono } from 'hono'
import { auditWriter } from '../lib/audit.js'
import { apiError, ok } from '../lib/errors.js'
import { listUsersByEmail, isExternalProviderUser, adminLinkProviderForUser } from '../lib/cognito.js'
import type { AuthContext } from '../middleware/auth.js'
import type { RequestIdContext } from '../middleware/request-id.js'
import { LinkAddProviderRequestSchema, createLogger } from '@heediq/shared'

const logger = createLogger('heediq-api')

type SettingsContext = AuthContext & RequestIdContext

const settings = new Hono<SettingsContext>()

function isAwsError(err: unknown): err is { name: string } {
  return typeof err === 'object' && err !== null && 'name' in err
}

// POST /api/v1/settings/link/add-provider — authenticated (D-083). Finishes the proactive
// Settings-linking round trip: SettingsLinkCallbackPage has already completed a fresh Hosted-UI
// OAuth exchange for the provider being added and extracted its {providerName, providerUserId}
// from the returned ID token's `identities` claim — this endpoint calls the Admin API
// (AdminLinkProviderForUser) that only the backend can reach, attaching that federated identity
// to the caller's own native Cognito user. Self-service (links the caller's own account only) —
// not gated by requirePermission, matching me.ts/auth-methods.ts (no RBAC permission exists for
// "manage my own identity", which is a self-scoped action, not an org-resource one, D-107).
settings.post('/add-provider', async (c) => {
  const body = await c.req.json()
  const parsed = LinkAddProviderRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }
  const { provider, providerUserId } = parsed.data

  // Email comes from the verified JWT (AuthContext), never the request body — the caller can
  // only ever link a provider onto their own account.
  const email = c.get('email')
  const users = await listUsersByEmail(email)
  const nativeUser = users.find((u) => !isExternalProviderUser(u))

  // AdminLinkProviderForUser's DestinationUser is always the native (COGNITO-provider) Cognito
  // user (lib/cognito.ts) — a caller with no password set yet has no native user to link onto.
  // SettingsPage doesn't gate its "Add Google/Microsoft" buttons on this today, so it's a real,
  // reachable path, not just defensive code.
  if (!nativeUser?.Username) {
    logger.warn('Provider link rejected — no native account to link onto', { requestId: c.get('requestId') })
    return apiError(c, 'BAD_REQUEST', 'Set a password before linking another sign-in method')
  }

  try {
    await adminLinkProviderForUser(nativeUser.Username, provider, providerUserId)
  } catch (err: unknown) {
    if (!isAwsError(err)) throw err
    if (err.name === 'InvalidParameterException') {
      // Already linked to this same user — idempotent, fall through to success.
    } else if (err.name === 'AliasExistsException' || err.name === 'ResourceConflictException') {
      logger.warn('Provider link rejected — already linked to another account', { requestId: c.get('requestId') })
      return apiError(c, 'CONFLICT', 'This account is already linked to another user')
    } else {
      throw err
    }
  }

  logger.info('Provider linked', { requestId: c.get('requestId'), accountId: c.get('userId') })
  await auditWriter(c)({
    resourceType: 'auth',
    action: 'auth:link-provider',
    after: { method: provider, email },
  })

  return ok(c, { linked: true })
})

export { settings as settingsRouter }
