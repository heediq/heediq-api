import { randomUUID } from 'node:crypto'
import { createMiddleware } from 'hono/factory'

// D-085: correlation ID for requests that don't yet have a sourceId (auth, /me, the initial
// upload before a Source row exists). Once a route creates/knows a sourceId, log both together
// so the two are joinable in CloudWatch Logs Insights.
export type RequestIdContext = {
  Variables: {
    requestId: string
  }
}

export const requestIdMiddleware = createMiddleware<RequestIdContext>(async (c, next) => {
  const requestId = c.req.header('X-Request-Id') ?? randomUUID()
  c.set('requestId', requestId)
  c.header('X-Request-Id', requestId)
  await next()
})
