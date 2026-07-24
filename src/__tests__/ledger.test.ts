import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED, type Permission } from '@heediq/shared'
import type { AuthContext } from '../middleware/auth.js'

const mockDynamoSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    dynamo: {
      contextsTable: 'heediq-contexts',
      decisionLedgerTable: 'heediq-decision-ledger',
      contextGrantsTable: 'heediq-context-grants',
      roleAssignmentsTable: 'heediq-role-assignments',
      auditLogTable: 'heediq-audit-log',
    },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

import { ledgerRouter } from '../routes/ledger.js'

function makeApp(opts: { userId?: string; role?: 'admin' | 'member'; permissions?: Permission[] } = {}) {
  const app = new Hono<AuthContext>()
  app.use('*', async (c, next) => {
    const role = opts.role ?? 'admin'
    c.set('userId', opts.userId ?? userId)
    c.set('orgId', orgId)
    c.set('email', 'a@b.com')
    c.set('role', role)
    c.set('permissions', opts.permissions ?? [...DEFAULT_ORG_RBAC_SEED[role].permissions])
    c.set('requestId', 'req-1')
    await next()
  })
  app.route('/', ledgerRouter)
  return app
}

const now = new Date().toISOString()
const orgId = '00000000-0000-0000-0000-000000000001'
const userId = '00000000-0000-0000-0000-000000000002'
const otherUserId = '00000000-0000-0000-0000-000000000003'
const contextId = '00000000-0000-0000-0000-000000000010'
const entryId = '00000000-0000-0000-0000-000000000020'

function personalContext(overrides: Record<string, unknown> = {}) {
  return {
    contextId, orgId, userId, domain: 'work', name: 'My Context',
    visibility: 'personal', status: 'active', createdAt: now, updatedAt: now, ...overrides,
  }
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    entryId, contextId, topic: 'Auth provider', answer: 'Cognito', status: 'confirmed',
    confidence: 0.8, origin: 'auto', sourceRefs: [], createdAt: now, updatedAt: now, ...overrides,
  }
}

const jsonHeaders = { 'Content-Type': 'application/json' }

describe('GET /:id/ledger', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the full ledger for an accessible context', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext() }) // loadContext
      .mockResolvedValueOnce({ Items: [entry(), entry({ entryId: '00000000-0000-0000-0000-000000000021', status: 'open', answer: null })] })

    const res = await makeApp().request(`/${contextId}/ledger`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { entries: unknown[] } }
    expect(body.data.entries).toHaveLength(2)
  })

  it('returns 404 for a personal context owned by someone else with no grant', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext({ userId: otherUserId }) })
      .mockResolvedValueOnce({}) // hasActiveGrant — no grant
    const res = await makeApp().request(`/${contextId}/ledger`)
    expect(res.status).toBe(404)
  })

  it('returns 404 when the context does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp().request(`/${contextId}/ledger`)
    expect(res.status).toBe(404)
  })
})

describe('POST /:id/ledger', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a user-origin entry, confirmed when answered, confidence forced to 1.0', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext() }) // loadContext
      .mockResolvedValueOnce({}) // PutCommand entry
      .mockResolvedValueOnce({}) // audit

    const res = await makeApp().request(`/${contextId}/ledger`, {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ topic: 'DB choice', answer: 'DynamoDB' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { origin: string; status: string; confidence: number; answer: string } }
    expect(body.data).toMatchObject({ origin: 'user', status: 'confirmed', confidence: 1, answer: 'DynamoDB' })
  })

  it('creates an open entry when no answer is supplied', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext() })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
    const res = await makeApp().request(`/${contextId}/ledger`, {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ topic: 'Rollout date?' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { status: string; answer: string | null } }
    expect(body.data).toMatchObject({ status: 'open', answer: null })
  })

  it('rejects an empty topic', async () => {
    const res = await makeApp().request(`/${contextId}/ledger`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ topic: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 403 without context:update', async () => {
    const res = await makeApp({ role: 'member', permissions: [] }).request(`/${contextId}/ledger`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ topic: 'x' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('PATCH /:id/ledger/:entryId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fills an open auto entry: sets answer, flips to user-origin/confirmed/confidence 1.0', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext() }) // loadContext
      .mockResolvedValueOnce({ Item: entry({ status: 'open', answer: null, origin: 'auto', confidence: 0.3 }) }) // loadEntry
      .mockResolvedValueOnce({}) // Put
      .mockResolvedValueOnce({}) // audit

    const res = await makeApp().request(`/${contextId}/ledger/${entryId}`, {
      method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ answer: 'Postgres' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { answer: string; origin: string; status: string; confidence: number; createdAt: string } }
    expect(body.data).toMatchObject({ answer: 'Postgres', origin: 'user', status: 'confirmed', confidence: 1 })
    expect(body.data.createdAt).toBe(now) // createdAt preserved
  })

  it('confirming a needs_review entry via explicit status keeps the existing answer', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext() })
      .mockResolvedValueOnce({ Item: entry({ status: 'needs_review', answer: 'Cognito' }) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
    const res = await makeApp().request(`/${contextId}/ledger/${entryId}`, {
      method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: 'confirmed' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { status: string; answer: string } }
    expect(body.data).toMatchObject({ status: 'confirmed', answer: 'Cognito' })
  })

  it('answer:null explicitly reopens the entry', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext() })
      .mockResolvedValueOnce({ Item: entry({ status: 'confirmed', answer: 'Cognito' }) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
    const res = await makeApp().request(`/${contextId}/ledger/${entryId}`, {
      method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ answer: null }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { status: string; answer: string | null } }
    expect(body.data).toMatchObject({ status: 'open', answer: null })
  })

  it('returns 404 when the entry does not exist', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext() })
      .mockResolvedValueOnce({}) // loadEntry — none
    const res = await makeApp().request(`/${contextId}/ledger/${entryId}`, {
      method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ answer: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('rejects an empty patch body', async () => {
    const res = await makeApp().request(`/${contextId}/ledger/${entryId}`, {
      method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /:id/ledger/:entryId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes an entry and audits before-only', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext() }) // loadContext
      .mockResolvedValueOnce({ Item: entry() }) // loadEntry
      .mockResolvedValueOnce({}) // Delete
      .mockResolvedValueOnce({}) // audit

    const res = await makeApp().request(`/${contextId}/ledger/${entryId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { entryId: string } }
    expect(body.data.entryId).toBe(entryId)
    expect(mockDynamoSend).toHaveBeenNthCalledWith(4,
      expect.objectContaining({
        input: expect.objectContaining({
          Item: expect.objectContaining({
            resourceType: 'ledgerEntry',
            action: 'ledgerEntry:delete',
            before: expect.objectContaining({ entryId, contextId }),
            after: undefined,
          }),
        }),
      }),
    )
  })

  it('returns 404 when the entry does not exist', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext() })
      .mockResolvedValueOnce({})
    const res = await makeApp().request(`/${contextId}/ledger/${entryId}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
