import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AuthContext } from '../middleware/auth.js'

const mockDynamoSend = vi.hoisted(() => vi.fn())
const mockListUsersByEmail = vi.hoisted(() => vi.fn())
const mockAdminLinkProviderForUser = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    dynamo: {
      auditLogTable: 'heediq-audit-log',
    },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

vi.mock('../lib/cognito.js', () => ({
  listUsersByEmail: mockListUsersByEmail,
  isExternalProviderUser: (u: { UserStatus?: string }) => u.UserStatus === 'EXTERNAL_PROVIDER',
  adminLinkProviderForUser: mockAdminLinkProviderForUser,
}))

import { settingsRouter } from '../routes/settings.js'

function awsError(name: string) {
  const err = new Error(name)
  err.name = name
  return err
}

function makeApp() {
  const app = new Hono<AuthContext>()
  app.use('*', async (c, next) => {
    c.set('userId', 'account-1')
    c.set('orgId', '00000000-0000-0000-0000-000000000001')
    c.set('email', 'a@b.com')
    c.set('role', 'member')
    c.set('permissions', [])
    await next()
  })
  app.route('/', settingsRouter)
  return app
}

describe('POST /settings/link/add-provider (D-083)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDynamoSend.mockResolvedValue({})
  })

  const validBody = { provider: 'Google', providerUserId: 'g1' }

  it('rejects an invalid request body', async () => {
    const res = await makeApp().request('/add-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'Google' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when the caller has no native account to link onto', async () => {
    mockListUsersByEmail.mockResolvedValueOnce([{ Username: 'Google_other', UserStatus: 'EXTERNAL_PROVIDER' }])

    const res = await makeApp().request('/add-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(400)
    expect(mockAdminLinkProviderForUser).not.toHaveBeenCalled()
  })

  it('links the provider onto the native user and writes an audit event', async () => {
    mockListUsersByEmail.mockResolvedValueOnce([{ Username: 'a@b.com', UserStatus: 'CONFIRMED' }])
    mockAdminLinkProviderForUser.mockResolvedValueOnce({})

    const res = await makeApp().request('/add-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { linked: boolean } }
    expect(body.data).toEqual({ linked: true })
    expect(mockAdminLinkProviderForUser).toHaveBeenCalledWith('a@b.com', 'Google', 'g1')

    const auditPut = mockDynamoSend.mock.calls[0]?.[0] as { input: { TableName: string; Item: Record<string, unknown> } }
    expect(auditPut.input.TableName).toBe('heediq-audit-log')
    expect(auditPut.input.Item).toMatchObject({ resourceType: 'auth', action: 'auth:link-provider' })
  })

  it('treats InvalidParameterException as already-linked and returns success', async () => {
    mockListUsersByEmail.mockResolvedValueOnce([{ Username: 'a@b.com', UserStatus: 'CONFIRMED' }])
    mockAdminLinkProviderForUser.mockRejectedValueOnce(awsError('InvalidParameterException'))

    const res = await makeApp().request('/add-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(200)
  })

  it('returns 409 when the provider is already linked to a different account', async () => {
    mockListUsersByEmail.mockResolvedValueOnce([{ Username: 'a@b.com', UserStatus: 'CONFIRMED' }])
    mockAdminLinkProviderForUser.mockRejectedValueOnce(awsError('AliasExistsException'))

    const res = await makeApp().request('/add-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(409)
  })
})
