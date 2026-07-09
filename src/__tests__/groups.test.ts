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

import { groupsRouter } from '../routes/groups.js'

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
  app.route('/', groupsRouter)
  return app
}

const now = new Date().toISOString()
const orgId = '00000000-0000-0000-0000-000000000001'
const userId = '00000000-0000-0000-0000-000000000002'
const groupId = '00000000-0000-0000-0000-000000000003'
const roleId = '00000000-0000-0000-0000-000000000004'

describe('GET /groups', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the org group list', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ pk: `ORG#${orgId}`, sk: `GROUP#${groupId}`, orgId, groupId, name: 'Engineering', roleIds: [roleId], createdAt: now, updatedAt: now }],
    })
    const res = await makeApp().request('/')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { groups: unknown[] } }
    expect(body.data.groups).toHaveLength(1)
  })
})

describe('POST /groups', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a group as admin when all roleIds exist in-org', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Responses: { 'heediq-roles': [{ pk: `ORG#${orgId}`, sk: `ROLE#${roleId}` }] } }) // BatchGetCommand
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand (group)
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand (audit)
    const res = await makeApp('admin').request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Engineering', roleIds: [roleId] }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { group: { name: string } } }
    expect(body.data.group.name).toBe('Engineering')
    expect(mockDynamoSend).toHaveBeenCalledTimes(3)
  })

  it('skips the roleIds existence check when roleIds is empty', async () => {
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand (group)
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand (audit)
    const res = await makeApp('admin').request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Empty group', roleIds: [] }),
    })
    expect(res.status).toBe(201)
    expect(mockDynamoSend).toHaveBeenCalledTimes(2)
  })

  it('rejects when a roleId does not exist in-org', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Responses: { 'heediq-roles': [] } }) // BatchGetCommand — none found
    const res = await makeApp('admin').request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Engineering', roleIds: [roleId] }),
    })
    expect(res.status).toBe(400)
    expect(mockDynamoSend).toHaveBeenCalledTimes(1)
  })

  it('rejects a caller missing org:manage-roles', async () => {
    const res = await makeApp('member').request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Engineering', roleIds: [] }),
    })
    expect(res.status).toBe(403)
    expect(mockDynamoSend).not.toHaveBeenCalled()
  })

  it('rejects an invalid body', async () => {
    const res = await makeApp('admin').request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', roleIds: [] }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /groups/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when the group does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp().request(`/${groupId}`)
    expect(res.status).toBe(404)
  })

  it('returns the group', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { pk: `ORG#${orgId}`, sk: `GROUP#${groupId}`, orgId, groupId, name: 'Engineering', roleIds: [], createdAt: now, updatedAt: now },
    })
    const res = await makeApp().request(`/${groupId}`)
    expect(res.status).toBe(200)
  })
})

describe('PATCH /groups/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a caller missing org:manage-roles', async () => {
    const res = await makeApp('member').request(`/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects an empty update body', async () => {
    const res = await makeApp('admin').request(`/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('rejects when an updated roleId does not exist in-org', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Responses: { 'heediq-roles': [] } }) // BatchGetCommand
    const res = await makeApp('admin').request(`/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleIds: [roleId] }),
    })
    expect(res.status).toBe(400)
  })

  it('updates the group and writes an audit entry with before/after', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { pk: `ORG#${orgId}`, sk: `GROUP#${groupId}`, orgId, groupId, name: 'Engineering', roleIds: [], createdAt: now, updatedAt: now },
    }) // GetCommand
    mockDynamoSend.mockResolvedValueOnce({
      Attributes: { pk: `ORG#${orgId}`, sk: `GROUP#${groupId}`, orgId, groupId, name: 'Renamed', roleIds: [], createdAt: now, updatedAt: now },
    }) // UpdateCommand
    mockDynamoSend.mockResolvedValueOnce({}) // audit PutCommand
    const res = await makeApp('admin').request(`/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { group: { name: string } } }
    expect(body.data.group.name).toBe('Renamed')
    expect(mockDynamoSend).toHaveBeenCalledTimes(3)
  })
})

describe('DELETE /groups/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a caller missing org:manage-roles', async () => {
    const res = await makeApp('member').request(`/${groupId}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the group does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp('admin').request(`/${groupId}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('deletes a group and writes an audit entry', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { pk: `ORG#${orgId}`, sk: `GROUP#${groupId}`, orgId, groupId, name: 'Engineering', roleIds: [], createdAt: now, updatedAt: now },
    }) // GetCommand
    mockDynamoSend.mockResolvedValueOnce({}) // DeleteCommand
    mockDynamoSend.mockResolvedValueOnce({}) // audit PutCommand
    const res = await makeApp('admin').request(`/${groupId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(mockDynamoSend).toHaveBeenCalledTimes(3)
  })
})
