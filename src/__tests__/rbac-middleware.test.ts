import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AuthContext } from '../middleware/auth.js'

const mockDynamoSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    dynamo: { auditLogTable: 'heediq-audit-log' },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

import { requirePermission } from '../middleware/rbac.js'

const orgId = '00000000-0000-0000-0000-000000000002'
const userId = '00000000-0000-0000-0000-000000000003'

function makeApp(permissions: string[]) {
  const app = new Hono<AuthContext>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('orgId', orgId)
    c.set('email', 'a@b.com')
    c.set('role', 'member')
    c.set('permissions', permissions as AuthContext['Variables']['permissions'])
    await next()
  })
  app.get('/gated', requirePermission('org:manage-roles'), (c) => c.json({ ok: true }))
  return app
}

describe('requirePermission', () => {
  beforeEach(() => vi.clearAllMocks())

  it('allows the request through when the token has the required permission', async () => {
    const res = await makeApp(['org:manage-roles']).request('/gated')
    expect(res.status).toBe(200)
    expect(mockDynamoSend).not.toHaveBeenCalled()
  })

  it('returns 403 FORBIDDEN when the token lacks the required permission — pure in-token check, no DB read (D-105)', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp(['sources:read']).request('/gated')
    expect(res.status).toBe(403)
    const body = await res.json() as { ok: boolean; error: { code: string; message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toMatch(/org:manage-roles/)
  })

  it('returns 403 when the permissions array is empty', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp([]).request('/gated')
    expect(res.status).toBe(403)
  })

  it('writes a denied permission audit entry on 403 (D-114)', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    await makeApp(['sources:read']).request('/gated')
    expect(mockDynamoSend).toHaveBeenCalledTimes(1)
    const putCommand = mockDynamoSend.mock.calls[0]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(putCommand.input.Item).toMatchObject({
      orgId,
      resourceType: 'permission',
      action: 'org:manage-roles',
      effect: 'denied',
      after: { permission: 'org:manage-roles' },
    })
  })

  it('does not write an audit entry when the permission check passes', async () => {
    await makeApp(['org:manage-roles']).request('/gated')
    expect(mockDynamoSend).not.toHaveBeenCalled()
  })

  it('still returns 403 (not 500) when the denial audit write itself fails', async () => {
    mockDynamoSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'))
    const res = await makeApp(['sources:read']).request('/gated')
    expect(res.status).toBe(403)
  })
})
