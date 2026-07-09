import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import type { AuthContext } from '../middleware/auth.js'

const mockDynamoSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: { dynamo: { usersTable: 'heediq-users' } },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

const { usersRouter } = await import('../routes/users.js')

const orgId = '00000000-0000-0000-0000-000000000002'
const callerId = '00000000-0000-0000-0000-000000000001'
const userId1 = '00000000-0000-0000-0000-000000000003'
const userId2 = '00000000-0000-0000-0000-000000000004'

function makeApp(role: 'admin' | 'member' = 'admin') {
  const app = new Hono<AuthContext>()
  app.use('*', async (c, next) => {
    c.set('userId', callerId)
    c.set('orgId', orgId)
    c.set('email', 'admin@acme.com')
    c.set('role', role)
    c.set('permissions', [...DEFAULT_ORG_RBAC_SEED[role].permissions])
    await next()
  })
  app.route('/', usersRouter)
  return app
}

describe('GET /users', () => {
  beforeEach(() => {
    mockDynamoSend.mockReset()
  })

  it('returns only the caller org users, querying the by-org GSI', async () => {
    mockDynamoSend.mockResolvedValue({
      Items: [
        { userId: userId1, orgId, email: 'a@acme.com', role: 'admin', passwordSet: true, createdAt: '2026-01-01T00:00:00.000Z' },
        { userId: userId2, orgId, email: 'b@acme.com', role: 'member', passwordSet: true, createdAt: '2026-01-02T00:00:00.000Z' },
      ],
    })

    const res = await makeApp('admin').request('/')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { users: { orgId: string }[] } }
    expect(body.data.users).toHaveLength(2)
    expect(body.data.users.every((u) => u.orgId === orgId)).toBe(true)

    const call = mockDynamoSend.mock.calls[0][0]
    expect(call.input.IndexName).toBe('by-org')
    expect(call.input.ExpressionAttributeValues[':orgId']).toBe(orgId)
  })

  it('returns an empty list for an org with no users', async () => {
    mockDynamoSend.mockResolvedValue({ Items: [] })

    const res = await makeApp('admin').request('/')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { users: unknown[] } }
    expect(body.data.users).toEqual([])
  })

  it('is accessible to a member caller (read-open, no permission gate)', async () => {
    mockDynamoSend.mockResolvedValue({ Items: [] })

    const res = await makeApp('member').request('/')
    expect(res.status).toBe(200)
  })
})
