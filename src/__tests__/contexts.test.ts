import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED, type Permission } from '@heediq/shared'
import type { AuthContext } from '../middleware/auth.js'

const mockDynamoSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    dynamo: {
      contextsTable: 'heediq-contexts',
      extractedItemsTable: 'heediq-extracted-items',
      roleAssignmentsTable: 'heediq-role-assignments',
      auditLogTable: 'heediq-audit-log',
    },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

import { contextsRouter } from '../routes/contexts.js'

function makeApp(opts: { userId?: string; orgId?: string; role?: 'admin' | 'member'; permissions?: Permission[] } = {}) {
  const app = new Hono<AuthContext>()
  app.use('*', async (c, next) => {
    const role = opts.role ?? 'admin'
    c.set('userId', opts.userId ?? userId)
    c.set('orgId', opts.orgId ?? orgId)
    c.set('email', 'a@b.com')
    c.set('role', role)
    c.set('permissions', opts.permissions ?? [...DEFAULT_ORG_RBAC_SEED[role].permissions])
    c.set('requestId', 'req-1')
    await next()
  })
  app.route('/', contextsRouter)
  return app
}

const now = new Date().toISOString()
const orgId = '00000000-0000-0000-0000-000000000001'
const otherOrgId = '00000000-0000-0000-0000-000000000099'
const userId = '00000000-0000-0000-0000-000000000002'
const otherUserId = '00000000-0000-0000-0000-000000000003'
const contextId = '00000000-0000-0000-0000-000000000010'
const otherContextId = '00000000-0000-0000-0000-000000000012'
const parentContextId = '00000000-0000-0000-0000-000000000011'
const missingParentContextId = '00000000-0000-0000-0000-000000000099'
const groupId = '00000000-0000-0000-0000-000000000020'

function personalContext(overrides: Record<string, unknown> = {}) {
  return {
    contextId,
    orgId,
    userId,
    domain: 'work',
    name: 'My Context',
    visibility: 'personal',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('GET /contexts', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists personal + org-scoped contexts', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Items: [personalContext()] }) // personal scope
      .mockResolvedValueOnce({ Items: [personalContext({ contextId: otherContextId, visibility: 'org' })] }) // org scope
    const res = await makeApp().request('/')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { contexts: unknown[] } }
    expect(body.data.contexts).toHaveLength(2)
  })

  it('filters by domain via the by-scope GSI sort key prefix', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({ Items: [] })
    await makeApp().request('/?domain=study')
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({ ':domainPrefix': 'study#' }),
        }),
      }),
    )
  })
})

describe('GET /contexts/tree', () => {
  beforeEach(() => vi.clearAllMocks())

  it('nests children under their parent', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Items: [personalContext({ contextId: parentContextId })] })
      .mockResolvedValueOnce({ Items: [personalContext({ contextId, parentContextId, visibility: 'org' })] })
    const res = await makeApp().request('/tree')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { tree: Array<{ contextId: string; children: unknown[] }> } }
    expect(body.data.tree).toHaveLength(1)
    expect(body.data.tree[0]?.contextId).toBe(parentContextId)
    expect(body.data.tree[0]?.children).toHaveLength(1)
  })

  it('surfaces a node whose parent is not in the visible set as its own root', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Items: [personalContext({ parentContextId: missingParentContextId })] })
      .mockResolvedValueOnce({ Items: [] })
    const res = await makeApp().request('/tree')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { tree: unknown[] } }
    expect(body.data.tree).toHaveLength(1)
  })
})

describe('POST /contexts', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a personal context by default and writes an after-only audit entry', async () => {
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand
    mockDynamoSend.mockResolvedValueOnce({}) // audit PutCommand
    const res = await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Context', domain: 'work' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { context: { visibility: string; name: string } } }
    expect(body.data.context.visibility).toBe('personal')
    expect(body.data.context.name).toBe('New Context')
    expect(mockDynamoSend).toHaveBeenCalledTimes(2)
  })

  it('rejects a caller missing context:create', async () => {
    const res = await makeApp({ permissions: [] }).request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', domain: 'work' }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects an invalid body', async () => {
    const res = await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects group visibility when the caller is not a member of the group', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }) // callerGroupIds — no memberships
    const res = await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', domain: 'work', visibility: 'group', groupId }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a parent that does not exist or is not visible', async () => {
    mockDynamoSend.mockResolvedValueOnce({}) // GetCommand parent — no Item
    const res = await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', domain: 'work', parentContextId }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /contexts/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when the context does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp().request(`/${contextId}`)
    expect(res.status).toBe(404)
  })

  it('returns the context for its owner', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: personalContext() })
    const res = await makeApp().request(`/${contextId}`)
    expect(res.status).toBe(200)
  })

  it('returns 404 for a personal context owned by someone else (cross-user isolation)', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: personalContext({ userId: otherUserId }) })
    const res = await makeApp().request(`/${contextId}`)
    expect(res.status).toBe(404)
  })

  it('returns 404 for a context belonging to a different org (cross-org isolation)', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: personalContext({ orgId: otherOrgId, userId: otherUserId, visibility: 'org' }) })
    const res = await makeApp().request(`/${contextId}`)
    expect(res.status).toBe(404)
  })

  it('returns an org-visible context to any org member', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: personalContext({ userId: otherUserId, visibility: 'org' }) })
    const res = await makeApp().request(`/${contextId}`)
    expect(res.status).toBe(200)
  })

  it('returns a group context to a live group member', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext({ userId: otherUserId, visibility: 'group', groupId }) })
      .mockResolvedValueOnce({ Items: [{ sk: `GROUP#${groupId}` }] }) // callerGroupIds
    const res = await makeApp().request(`/${contextId}`)
    expect(res.status).toBe(200)
  })

  it('returns 404 for a group context when the caller is not a member', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext({ userId: otherUserId, visibility: 'group', groupId }) })
      .mockResolvedValueOnce({ Items: [] }) // callerGroupIds — no memberships
    const res = await makeApp().request(`/${contextId}`)
    expect(res.status).toBe(404)
  })
})

describe('PATCH /contexts/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a caller missing context:update', async () => {
    const res = await makeApp({ permissions: [] }).request(`/${contextId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the context does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp().request(`/${contextId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the caller cannot access the context', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: personalContext({ userId: otherUserId }) })
    const res = await makeApp().request(`/${contextId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(res.status).toBe(404)
  })

  it('rejects a context as its own parent', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: personalContext() })
    const res = await makeApp().request(`/${contextId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentContextId: contextId }),
    })
    expect(res.status).toBe(400)
  })

  it('updates the context and writes a before/after audit entry', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: personalContext() }) // GetCommand
    mockDynamoSend.mockResolvedValueOnce({ Attributes: personalContext({ name: 'Renamed' }) }) // UpdateCommand
    mockDynamoSend.mockResolvedValueOnce({}) // audit PutCommand
    const res = await makeApp().request(`/${contextId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { context: { name: string } } }
    expect(body.data.context.name).toBe('Renamed')
    expect(mockDynamoSend).toHaveBeenCalledTimes(3)
  })

  it('re-validates group membership when moving a context to group visibility', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: personalContext() }) // GetCommand
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }) // callerGroupIds — no memberships
    const res = await makeApp().request(`/${contextId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'group', groupId }),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /contexts/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a caller missing context:delete', async () => {
    const res = await makeApp({ permissions: [] }).request(`/${contextId}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the context does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp().request(`/${contextId}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('returns 409 when child contexts exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: personalContext() }) // GetCommand
    mockDynamoSend.mockResolvedValueOnce({ Items: [personalContext({ contextId: 'child', parentContextId: contextId })] }) // children query
    const res = await makeApp().request(`/${contextId}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
  })

  it('deletes the context and writes a before-only audit entry', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: personalContext() }) // GetCommand
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }) // children query — none
    mockDynamoSend.mockResolvedValueOnce({}) // DeleteCommand
    mockDynamoSend.mockResolvedValueOnce({}) // audit PutCommand
    const res = await makeApp().request(`/${contextId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(mockDynamoSend).toHaveBeenCalledTimes(4)
  })
})
