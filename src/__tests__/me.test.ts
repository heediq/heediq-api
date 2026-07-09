import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import type { AuthContext } from '../middleware/auth.js'

const mockDynamoSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    dynamo: {
      usersTable: 'heediq-users',
      orgsTable: 'heediq-orgs',
    },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

const { meRouter } = await import('../routes/me.js')

const userId = '00000000-0000-0000-0000-000000000001'
const orgId = '00000000-0000-0000-0000-000000000002'

function makeApp(role: 'admin' | 'member' = 'admin') {
  const app = new Hono<AuthContext>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('orgId', orgId)
    c.set('email', 'admin@acme.com')
    c.set('role', role)
    c.set('permissions', [...DEFAULT_ORG_RBAC_SEED[role].permissions])
    await next()
  })
  app.route('/', meRouter)
  return app
}

describe('GET /me', () => {
  beforeEach(() => {
    mockDynamoSend.mockReset()
  })

  it('returns effectivePermissions matching the token permissions claim', async () => {
    mockDynamoSend.mockImplementation((cmd: { input: { TableName: string } }) => {
      if (cmd.input.TableName === 'heediq-users') {
        return Promise.resolve({ Item: { userId, orgId, email: 'admin@acme.com', role: 'admin', passwordSet: true, createdAt: '2026-01-01T00:00:00.000Z' } })
      }
      return Promise.resolve({ Item: { orgId, name: 'Acme', plan: 'free', seatCount: 1, usageLifetimeCount: 0, createdAt: '2026-01-01T00:00:00.000Z' } })
    })

    const res = await makeApp('admin').request('/')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { effectivePermissions: string[] } }
    expect(body.data.effectivePermissions).toEqual([...DEFAULT_ORG_RBAC_SEED.admin.permissions])
  })

  it('returns the narrower member permission set for a member caller', async () => {
    mockDynamoSend.mockImplementation((cmd: { input: { TableName: string } }) => {
      if (cmd.input.TableName === 'heediq-users') {
        return Promise.resolve({ Item: { userId, orgId, email: 'member@acme.com', role: 'member', passwordSet: true, createdAt: '2026-01-01T00:00:00.000Z' } })
      }
      return Promise.resolve({ Item: { orgId, name: 'Acme', plan: 'free', seatCount: 1, usageLifetimeCount: 0, createdAt: '2026-01-01T00:00:00.000Z' } })
    })

    const res = await makeApp('member').request('/')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { effectivePermissions: string[] } }
    expect(body.data.effectivePermissions).toEqual([...DEFAULT_ORG_RBAC_SEED.member.permissions])
  })

  it('returns 404 when the user or org is missing', async () => {
    mockDynamoSend.mockResolvedValue({ Item: undefined })

    const res = await makeApp('admin').request('/')
    expect(res.status).toBe(404)
  })
})
