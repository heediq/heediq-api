import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createLogger } from '@heediq/shared'
import { authMiddleware } from './middleware/auth.js'
import { requestIdMiddleware, type RequestIdContext } from './middleware/request-id.js'
import { meRouter } from './routes/me.js'
import { sourcesRouter } from './routes/sources.js'
import { contextsRouter } from './routes/contexts.js'
import { contextGrantsRouter } from './routes/context-grants.js'
import { conversationsRouter } from './routes/conversations.js'
import { uploadRouter } from './routes/upload.js'
import { authRouter } from './routes/auth.js'
import { authMethodsRouter } from './routes/auth-methods.js'
import { rolesRouter } from './routes/roles.js'
import { groupsRouter } from './routes/groups.js'
import { roleAssignmentsRouter } from './routes/role-assignments.js'
import { usersRouter } from './routes/users.js'
import { auditLogRouter } from './routes/audit-log.js'
import { settingsRouter } from './routes/settings.js'
import { config } from './config.js'
import { apiError } from './lib/errors.js'

const logger = createLogger('heediq-api')

const app = new Hono<RequestIdContext>()

// D-085: assign a correlation ID to every request before anything else, so it's available to
// the global error handler and every route regardless of which sub-router handles it.
app.use('*', requestIdMiddleware)

// CORS — origins injected by CDK (CORS_ORIGINS env var)
app.use('*', cors({
  origin: config.cors.origins,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}))

// Unauthenticated account-linking routes (D-078, D-079) — mounted outside the
// authMiddleware group deliberately; a signed-in-only guard would defeat their purpose
// (looking up an email / starting a link BEFORE a session exists).
app.route('/api/v1/auth', authRouter)

// All routes under /api/v1/ require auth (D-041, D-042)
const v1 = new Hono()
v1.use('*', authMiddleware)
v1.route('/me', meRouter)
v1.route('/sources', sourcesRouter)
v1.route('/contexts', contextsRouter)
v1.route('/context-grants', contextGrantsRouter)
v1.route('/conversations', conversationsRouter)
v1.route('/upload', uploadRouter)
v1.route('/auth/methods', authMethodsRouter)
v1.route('/roles', rolesRouter)
v1.route('/groups', groupsRouter)
// D-102: roleAssignmentsRouter declares its own `/:userId/role-assignments...` paths (rather
// than being mounted under a parent `:userId` segment) so Hono's route-param typing recognizes
// `userId` within the router — a parent-level param isn't visible to a Hono sub-app's own types.
v1.route('/users', roleAssignmentsRouter)
// D-102 Phase 4: org-scoped user list for the role/group assignment screen. Internal path is
// `/` (vs roleAssignmentsRouter's `/:userId/role-assignments...`) so the two routers compose
// on the same `/users` prefix without colliding.
v1.route('/users', usersRouter)
// D-102 Phase 5: audit-log viewer, gated by `requirePermission('audit:read')` inside the router.
v1.route('/org/audit-log', auditLogRouter)
// D-083: finishes proactive Settings provider-linking (self-service, no requirePermission —
// see settings.ts).
v1.route('/settings/link', settingsRouter)

app.route('/api/v1', v1)

// 404 fallback
app.notFound((c) => apiError(c, 'NOT_FOUND', 'Route not found'))

// Global error handler — fail loudly in dev, structured in prod
app.onError((err, c) => {
  logger.error('Unhandled request error', {
    requestId: c.get('requestId'),
    sourceId: c.req.param('id'),
    path: c.req.path,
    error: err.message,
    stack: err.stack,
  })
  return apiError(c, 'INTERNAL_ERROR', 'An unexpected error occurred')
})

export { app }
