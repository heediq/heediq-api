import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AuthContext } from '../middleware/auth.js'

const mockDynamoSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    dynamo: { userAuthMethodsTable: 'heediq-user-auth-methods' },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

import { authMethodsRouter } from '../routes/auth-methods.js'

function makeApp(userId: string) {
  const app = new Hono<AuthContext>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('orgId', 'org-1')
    c.set('email', 'a@b.com')
    c.set('role', 'admin')
    await next()
  })
  app.route('/', authMethodsRouter)
  return app
}

const userA = '00000000-0000-0000-0000-000000000001'

describe('GET /auth/methods', () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the caller's active methods, scoped to their own userId (cross-org isolation)", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        { provider: 'COGNITO', linkedAt: '2026-01-01T00:00:00.000Z' },
        { provider: 'Google', linkedAt: '2026-01-02T00:00:00.000Z' },
      ],
    })

    const res = await makeApp(userA).request('/')

    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { methods: { provider: string }[] } }
    expect(body.data.methods).toEqual([
      { provider: 'COGNITO', linkedAt: '2026-01-01T00:00:00.000Z' },
      { provider: 'Google', linkedAt: '2026-01-02T00:00:00.000Z' },
    ])

    const queryArg = mockDynamoSend.mock.calls[0]?.[0] as { input: { ExpressionAttributeValues: Record<string, string> } }
    expect(queryArg.input.ExpressionAttributeValues[':pk']).toBe(`USER#${userA}`)
  })

  it('returns an empty list when the user has no recorded methods yet', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })

    const res = await makeApp(userA).request('/')

    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { methods: unknown[] } }
    expect(body.data.methods).toEqual([])
  })
})
