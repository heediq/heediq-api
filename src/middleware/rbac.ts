import { createMiddleware } from 'hono/factory'
import { apiError } from '../lib/errors.js'
import type { AuthContext } from './auth.js'
import type { Permission } from '@heediq/shared'

// Sole real enforcement point for RBAC (D-102) — a pure in-token check against the
// `permissions` array authMiddleware already parsed from `custom:permissions`. No DynamoDB
// read on the request path (D-105): a revoked permission stops being enforced only once the
// user's token next refreshes, not immediately.
export function requirePermission(permission: Permission) {
  return createMiddleware<AuthContext>(async (c, next) => {
    if (!c.get('permissions').includes(permission)) {
      return apiError(c, 'FORBIDDEN', `Missing required permission: ${permission}`)
    }
    await next()
  })
}
