import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import type { AuthContext } from '../middleware/auth.js'

const mockDynamoSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    dynamo: {
      rolesTable: 'heediq-roles',
      groupsTable: 'heediq-groups',
      roleAssignmentsTable: 'heediq-role-assignments',
      auditLogTable: 'heediq-audit-log',
      usersTable: 'heediq-users',
    },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

import { rolesRouter } from '../routes/roles.js'

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
  app.route('/', rolesRouter)
  return app
}

const now = new Date().toISOString()
const orgId = '00000000-0000-0000-0000-000000000001'
const userId = '00000000-0000-0000-0000-000000000002'
const roleId = '00000000-0000-0000-0000-000000000003'

describe('GET /roles', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the org role list', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ pk: `ORG#${orgId}`, sk: `ROLE#${roleId}`, orgId, roleId, name: 'Reviewer', permissions: ['sources:read'], isSystemRole: false, createdAt: now, updatedAt: now }],
    })
    const res = await makeApp().request('/')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { roles: unknown[] } }
    expect(body.data.roles).toHaveLength(1)
  })

  it('queries the roles table scoped to the caller org', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    await makeApp().request('/')
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ ExpressionAttributeValues: { ':pk': `ORG#${orgId}`, ':skPrefix': 'ROLE#' } }) }),
    )
  })
})

describe('POST /roles', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a role as admin', async () => {
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand (role)
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand (audit)
    const res = await makeApp('admin').request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reviewer', permissions: ['sources:read'] }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { role: { name: string; isSystemRole: boolean } } }
    expect(body.data.role.name).toBe('Reviewer')
    expect(body.data.role.isSystemRole).toBe(false)
    expect(mockDynamoSend).toHaveBeenCalledTimes(2)
  })

  it('rejects a caller missing org:manage-roles', async () => {
    const res = await makeApp('member').request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reviewer', permissions: [] }),
    })
    expect(res.status).toBe(403)
    expect(mockDynamoSend).not.toHaveBeenCalled()
  })

  it('rejects an invalid body', async () => {
    const res = await makeApp('admin').request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', permissions: [] }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /roles/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when the role does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp().request(`/${roleId}`)
    expect(res.status).toBe(404)
  })

  it('returns the role', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId}`, orgId, roleId, name: 'Reviewer', permissions: [], isSystemRole: false, createdAt: now, updatedAt: now },
    })
    const res = await makeApp().request(`/${roleId}`)
    expect(res.status).toBe(200)
  })
})

describe('PATCH /roles/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a caller missing org:manage-roles', async () => {
    const res = await makeApp('member').request(`/${roleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects an empty update body', async () => {
    const res = await makeApp('admin').request(`/${roleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when the role does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({}) // GetCommand — no Item
    const res = await makeApp('admin').request(`/${roleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(res.status).toBe(404)
  })

  it('updates the role and writes an audit entry with before/after', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId}`, orgId, roleId, name: 'Reviewer', permissions: ['sources:read'], isSystemRole: false, createdAt: now, updatedAt: now },
    }) // GetCommand
    mockDynamoSend.mockResolvedValueOnce({
      Attributes: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId}`, orgId, roleId, name: 'Renamed', permissions: ['sources:read'], isSystemRole: false, createdAt: now, updatedAt: now },
    }) // UpdateCommand
    mockDynamoSend.mockResolvedValueOnce({}) // audit PutCommand
    const res = await makeApp('admin').request(`/${roleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { role: { name: string } } }
    expect(body.data.role.name).toBe('Renamed')
    expect(mockDynamoSend).toHaveBeenCalledTimes(3)
  })
})

describe('DELETE /roles/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a caller missing org:manage-roles', async () => {
    const res = await makeApp('member').request(`/${roleId}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the role does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp('admin').request(`/${roleId}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('returns 409 when attempting to delete a system role', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId}`, orgId, roleId, name: 'admin', permissions: [], isSystemRole: true, createdAt: now, updatedAt: now },
    })
    const res = await makeApp('admin').request(`/${roleId}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(mockDynamoSend).toHaveBeenCalledTimes(1)
  })

  it('deletes a custom role and writes an audit entry', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId}`, orgId, roleId, name: 'Reviewer', permissions: [], isSystemRole: false, createdAt: now, updatedAt: now },
    }) // GetCommand
    mockDynamoSend.mockResolvedValueOnce({}) // DeleteCommand
    mockDynamoSend.mockResolvedValueOnce({}) // audit PutCommand
    const res = await makeApp('admin').request(`/${roleId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(mockDynamoSend).toHaveBeenCalledTimes(3)
  })
})
