import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createLogger } from '@heediq/shared'
import { authMiddleware } from './middleware/auth.js'
import { requestIdMiddleware, type RequestIdContext } from './middleware/request-id.js'
import { meRouter } from './routes/me.js'
import { sourcesRouter } from './routes/sources.js'
import { uploadRouter } from './routes/upload.js'
import { authRouter } from './routes/auth.js'
import { authMethodsRouter } from './routes/auth-methods.js'
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
v1.route('/upload', uploadRouter)
v1.route('/auth/methods', authMethodsRouter)

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
