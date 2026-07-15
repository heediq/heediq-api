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

import { roleAssignmentsRouter } from '../routes/role-assignments.js'

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
  app.route('/users', roleAssignmentsRouter)
  return app
}

const now = new Date().toISOString()
const orgId = '00000000-0000-0000-0000-000000000001'
const callerId = '00000000-0000-0000-0000-000000000002'
const targetUserId = '00000000-0000-0000-0000-000000000003'
const roleId = '00000000-0000-0000-0000-000000000004'
const groupId = '00000000-0000-0000-0000-000000000005'

describe('GET /users/:userId/role-assignments', () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the user's assignments", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ pk: `ORG#${orgId}#USER#${targetUserId}`, sk: `ROLE#${roleId}`, assignmentType: 'role', userId: targetUserId, roleId, createdAt: now }],
    })
    const res = await makeApp().request(`/users/${targetUserId}/role-assignments`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { roleAssignments: unknown[] } }
    expect(body.data.roleAssignments).toHaveLength(1)
  })
})

describe('POST /users/:userId/role-assignments', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a caller missing org:manage-roles', async () => {
    const res = await makeApp('member').request(`/users/${targetUserId}/role-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentType: 'role', roleId }),
    })
    expect(res.status).toBe(403)
    // No route-level DB access happens (the handler never runs) — the one call is
    // requirePermission's own denial audit write (D-114), not a route-triggered read/write.
    expect(mockDynamoSend).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid body', async () => {
    const res = await makeApp('admin').request(`/users/${targetUserId}/role-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentType: 'user', userId: targetUserId }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when the target user does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({}) // GetCommand users table — no Item
    const res = await makeApp('admin').request(`/users/${targetUserId}/role-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentType: 'role', roleId }),
    })
    expect(res.status).toBe(404)
  })

  it('assigns a role, validates it exists in-org, and writes an audit entry', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { userId: targetUserId, email: 'target@acme.com' } }) // users GetCommand
    mockDynamoSend.mockResolvedValueOnce({ Item: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId}`, name: 'Reviewer' } }) // roles GetCommand
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand (assignment)
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand (audit)
    const res = await makeApp('admin').request(`/users/${targetUserId}/role-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentType: 'role', roleId }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { roleAssignment: { assignmentType: string; roleId: string } } }
    expect(body.data.roleAssignment).toMatchObject({ assignmentType: 'role', roleId })
    expect(mockDynamoSend).toHaveBeenCalledTimes(4)
  })

  it('rejects a role assignment when the roleId does not exist in-org', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { userId: targetUserId, email: 'target@acme.com' } }) // users GetCommand
    mockDynamoSend.mockResolvedValueOnce({}) // roles GetCommand — no Item
    const res = await makeApp('admin').request(`/users/${targetUserId}/role-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentType: 'role', roleId }),
    })
    expect(res.status).toBe(400)
  })

  it('assigns a group, validates it exists in-org, and writes an audit entry', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { userId: targetUserId, email: 'target@acme.com' } }) // users GetCommand
    mockDynamoSend.mockResolvedValueOnce({ Item: { pk: `ORG#${orgId}`, sk: `GROUP#${groupId}`, name: 'Engineering' } }) // groups GetCommand
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand (assignment)
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand (audit)
    const res = await makeApp('admin').request(`/users/${targetUserId}/role-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentType: 'group', groupId }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { roleAssignment: { assignmentType: string; groupId: string } } }
    expect(body.data.roleAssignment).toMatchObject({ assignmentType: 'group', groupId })
    expect(mockDynamoSend).toHaveBeenCalledTimes(4)
  })
})

describe('DELETE /users/:userId/role-assignments/role/:roleId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a caller missing org:manage-roles', async () => {
    const res = await makeApp('member').request(`/users/${targetUserId}/role-assignments/role/${roleId}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the assignment does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({}) // GetCommand assignment — no Item
    const res = await makeApp('admin').request(`/users/${targetUserId}/role-assignments/role/${roleId}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('unassigns the role and writes an audit entry', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { assignmentType: 'role', userId: targetUserId, roleId, createdAt: now } }) // GetCommand assignment
    mockDynamoSend.mockResolvedValueOnce({ Item: { userId: targetUserId, email: 'target@acme.com' } }) // GetCommand user
    mockDynamoSend.mockResolvedValueOnce({ Item: { name: 'Reviewer' } }) // GetCommand role
    mockDynamoSend.mockResolvedValueOnce({}) // DeleteCommand
    mockDynamoSend.mockResolvedValueOnce({}) // audit PutCommand
    const res = await makeApp('admin').request(`/users/${targetUserId}/role-assignments/role/${roleId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(mockDynamoSend).toHaveBeenCalledTimes(5)
  })
})

describe('DELETE /users/:userId/role-assignments/group/:groupId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a caller missing org:manage-roles', async () => {
    const res = await makeApp('member').request(`/users/${targetUserId}/role-assignments/group/${groupId}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the assignment does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({}) // GetCommand assignment — no Item
    const res = await makeApp('admin').request(`/users/${targetUserId}/role-assignments/group/${groupId}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('unassigns the group and writes an audit entry', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { assignmentType: 'group', userId: targetUserId, groupId, createdAt: now } }) // GetCommand assignment
    mockDynamoSend.mockResolvedValueOnce({ Item: { userId: targetUserId, email: 'target@acme.com' } }) // GetCommand user
    mockDynamoSend.mockResolvedValueOnce({ Item: { name: 'Engineering' } }) // GetCommand group
    mockDynamoSend.mockResolvedValueOnce({}) // DeleteCommand
    mockDynamoSend.mockResolvedValueOnce({}) // audit PutCommand
    const res = await makeApp('admin').request(`/users/${targetUserId}/role-assignments/group/${groupId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(mockDynamoSend).toHaveBeenCalledTimes(5)
  })
})
