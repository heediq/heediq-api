import { createMiddleware } from 'hono/factory'
import { createLogger } from '@heediq/shared'
import { apiError } from '../lib/errors.js'
import { auditWriter } from '../lib/audit.js'
import type { AuthContext } from './auth.js'
import type { Permission } from '@heediq/shared'

const logger = createLogger('heediq-api')

// Sole real enforcement point for RBAC (D-102) — a pure in-token check against the
// `permissions` array authMiddleware already parsed from `custom:permissions`. No DynamoDB
// read on the request path (D-105): a revoked permission stops being enforced only once the
// user's token next refreshes, not immediately.
//
// Also the sole write point for denial audit entries (D-114): the framework is meant to check
// AND record in one call, not leave denied attempts with no trace. A denial audit-write failure
// is logged but never turned into a 500 or allowed to mask the 403 — the permission check itself
// already succeeded in its real job (blocking the request).
export function requirePermission(permission: Permission) {
  return createMiddleware<AuthContext>(async (c, next) => {
    if (!c.get('permissions').includes(permission)) {
      await auditWriter(c)({
        resourceType: 'permission',
        action: permission,
        effect: 'denied',
        after: { permission },
      }).catch((err: unknown) => {
        logger.error('Failed to write permission-denial audit event', {
          permission,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      return apiError(c, 'FORBIDDEN', `Missing required permission: ${permission}`)
    }
    await next()
  })
}
