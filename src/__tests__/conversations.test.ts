import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED, type Permission } from '@heediq/shared'
import type { AuthContext } from '../middleware/auth.js'

const mockDynamoSend = vi.hoisted(() => vi.fn())
const mockSqsSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    dynamo: {
      contextsTable: 'heediq-contexts',
      conversationsTable: 'heediq-conversations',
      chatMessagesTable: 'heediq-chat-messages',
      decisionLedgerTable: 'heediq-decision-ledger',
      orgsTable: 'heediq-orgs',
      roleAssignmentsTable: 'heediq-role-assignments',
      contextGrantsTable: 'heediq-context-grants',
      auditLogTable: 'heediq-audit-log',
    },
    sqs: { chatQueueUrl: 'https://sqs/chat' },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(() => ({ send: mockSqsSend })),
  SendMessageCommand: vi.fn((input) => input),
}))

import { conversationsRouter } from '../routes/conversations.js'

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
  app.route('/', conversationsRouter)
  return app
}

const now = new Date().toISOString()
const orgId = '00000000-0000-0000-0000-000000000001'
const otherOrgId = '00000000-0000-0000-0000-000000000099'
const userId = '00000000-0000-0000-0000-000000000002'
const otherUserId = '00000000-0000-0000-0000-000000000003'
const contextId = '00000000-0000-0000-0000-000000000010'
const conversationId = '00000000-0000-0000-0000-000000000030'
const entryOpenId = '00000000-0000-0000-0000-000000000040'
const entryReviewId = '00000000-0000-0000-0000-000000000041'

function ledgerEntry(overrides: Record<string, unknown> = {}) {
  return {
    entryId: '00000000-0000-0000-0000-000000000042',
    contextId,
    topic: 'A decision',
    answer: 'settled',
    status: 'confirmed',
    confidence: 0.9,
    origin: 'auto',
    sourceRefs: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

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

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    conversationId,
    contextId,
    orgId,
    userId,
    title: 'My Chat',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('POST /conversations', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a conversation on an accessible context', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext() }) // loadContext
      .mockResolvedValueOnce({}) // PutCommand
      .mockResolvedValueOnce({}) // audit PutCommand
    const res = await makeApp().request('/?contextId=' + contextId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Chat' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { conversation: { title: string; contextId: string } } }
    expect(body.data.conversation.title).toBe('New Chat')
    expect(body.data.conversation.contextId).toBe(contextId)
  })

  it('requires a contextId query parameter', async () => {
    const res = await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Chat' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects an invalid body', async () => {
    const res = await makeApp().request('/?contextId=' + contextId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when the context does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp().request('/?contextId=' + contextId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Chat' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 for a personal context owned by someone else and no grant', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext({ userId: otherUserId }) }) // loadContext
      .mockResolvedValueOnce({}) // hasActiveGrant fallback — no grant row
    const res = await makeApp().request('/?contextId=' + contextId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Chat' }),
    })
    expect(res.status).toBe(404)
  })

  it('a read-only grant does not authorize starting a conversation', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext({ orgId: otherOrgId, userId: otherUserId, visibility: 'org' }) }) // loadContext
      .mockResolvedValueOnce({
        Item: {
          contextId,
          granteeUserId: userId,
          granteeOrgId: orgId,
          ownerOrgId: otherOrgId,
          grantedByUserId: otherUserId,
          access: 'read',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          createdAt: now,
          updatedAt: now,
        },
      }) // hasActiveGrant
    const res = await makeApp().request('/?contextId=' + contextId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Chat' }),
    })
    expect(res.status).toBe(404)
  })

  it('rejects a caller missing context:read', async () => {
    const res = await makeApp({ permissions: [] }).request('/?contextId=' + contextId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Chat' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('GET /conversations', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists a context\'s conversations most-recently-active first', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext() }) // loadContext
      .mockResolvedValueOnce({ Items: [conversation()] }) // by-context query
    const res = await makeApp().request('/?contextId=' + contextId)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { conversations: unknown[] } }
    expect(body.data.conversations).toHaveLength(1)
    expect(mockDynamoSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ IndexName: 'by-context', ScanIndexForward: false }),
      }),
    )
  })

  it('returns 404 for a context the caller cannot access', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: personalContext({ userId: otherUserId }) })
      .mockResolvedValueOnce({}) // hasActiveGrant fallback
    const res = await makeApp().request('/?contextId=' + contextId)
    expect(res.status).toBe(404)
  })
})

describe('GET /conversations/:id/messages', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when the conversation does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp().request(`/${conversationId}/messages`)
    expect(res.status).toBe(404)
  })

  it('returns chronological messages for an accessible conversation', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: conversation() }) // loadConversation
      .mockResolvedValueOnce({ Item: personalContext() }) // loadContext
      .mockResolvedValueOnce({
        Items: [
          { conversationId, sk: `${now}#msg1`, messageId: '00000000-0000-0000-0000-000000000040', role: 'user', content: 'hi', createdAt: now },
        ],
      })
    const res = await makeApp().request(`/${conversationId}/messages`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { messages: unknown[] } }
    expect(body.data.messages).toHaveLength(1)
  })

  it('returns 404 when the parent context is no longer accessible', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: conversation({ contextId }) })
      .mockResolvedValueOnce({ Item: personalContext({ userId: otherUserId }) })
      .mockResolvedValueOnce({}) // hasActiveGrant fallback
    const res = await makeApp().request(`/${conversationId}/messages`)
    expect(res.status).toBe(404)
  })
})

describe('POST /conversations/:id/messages', () => {
  beforeEach(() => vi.clearAllMocks())

  it('persists the user message, touches the conversation, and enqueues a chat job', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: conversation() }) // loadConversation
      .mockResolvedValueOnce({ Item: personalContext() }) // loadContext
      .mockResolvedValueOnce({ Items: [] }) // D-149 gating query — empty ledger, no block
      .mockResolvedValueOnce({}) // PutCommand message
      .mockResolvedValueOnce({}) // UpdateCommand touch
      .mockResolvedValueOnce({ Item: { orgId, plan: 'paid' } }) // resolveTier
      .mockResolvedValueOnce({}) // audit PutCommand
    mockSqsSend.mockResolvedValueOnce({})

    const res = await makeApp().request(`/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'What did we decide?' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { message: { role: string; content: string } } }
    expect(body.data.message.role).toBe('user')
    expect(body.data.message.content).toBe('What did we decide?')

    expect(mockSqsSend).toHaveBeenCalledOnce()
    const enqueued = mockSqsSend.mock.calls[0][0]
    expect(enqueued.QueueUrl).toBe('https://sqs/chat')
    const job = JSON.parse(enqueued.MessageBody)
    expect(job).toMatchObject({ conversationId, contextId, orgId, userId, tier: 'paid' })
  })

  it('defaults tier to free when the org has no plan set', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: conversation() })
      .mockResolvedValueOnce({ Item: personalContext() })
      .mockResolvedValueOnce({ Items: [] }) // D-149 gating query — empty ledger
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({}) // resolveTier — no Item
      .mockResolvedValueOnce({})
    mockSqsSend.mockResolvedValueOnce({})

    const res = await makeApp().request(`/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    })
    expect(res.status).toBe(201)
    const job = JSON.parse(mockSqsSend.mock.calls[0][0].MessageBody)
    expect(job.tier).toBe('free')
  })

  it('gates the turn (LEDGER_GATED) when the context has an unsettled ledger entry (D-149)', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: conversation() }) // loadConversation
      .mockResolvedValueOnce({ Item: personalContext() }) // loadContext
      .mockResolvedValueOnce({ Items: [ // D-149 gating query
        ledgerEntry({ status: 'confirmed' }),
        ledgerEntry({ entryId: entryOpenId, topic: 'Which DB?', answer: null, status: 'open' }),
        ledgerEntry({ entryId: entryReviewId, topic: 'Auth provider', status: 'needs_review' }),
      ] })

    const res = await makeApp().request(`/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'go' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: { code: string; details: { blockingEntries: { entryId: string; topic: string; status: string }[] } } }
    expect(body.error.code).toBe('LEDGER_GATED')
    expect(body.error.details.blockingEntries).toHaveLength(2)
    expect(body.error.details.blockingEntries.map((e) => e.status).sort()).toEqual(['needs_review', 'open'])
    // Nothing persisted or enqueued on a block.
    expect(mockSqsSend).not.toHaveBeenCalled()
    expect(mockDynamoSend).toHaveBeenCalledTimes(3)
  })

  it('bypasses gating when bypassLedgerGating is set, even with unsettled entries (D-149)', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: conversation() }) // loadConversation
      .mockResolvedValueOnce({ Item: personalContext() }) // loadContext
      // no gating query — bypass short-circuits it
      .mockResolvedValueOnce({}) // PutCommand message
      .mockResolvedValueOnce({}) // UpdateCommand touch
      .mockResolvedValueOnce({ Item: { orgId, plan: 'free' } }) // resolveTier
      .mockResolvedValueOnce({}) // audit
    mockSqsSend.mockResolvedValueOnce({})

    const res = await makeApp().request(`/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'go anyway', bypassLedgerGating: true }),
    })
    expect(res.status).toBe(201)
    expect(mockSqsSend).toHaveBeenCalledOnce()
  })

  it('rejects an empty message body', async () => {
    const res = await makeApp().request(`/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    })
    expect(res.status).toBe(400)
    expect(mockSqsSend).not.toHaveBeenCalled()
  })

  it('returns 404 when the conversation does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp().request(`/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    })
    expect(res.status).toBe(404)
    expect(mockSqsSend).not.toHaveBeenCalled()
  })

  it('returns 404 when the caller lost contribute access to the parent context', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: conversation() })
      .mockResolvedValueOnce({ Item: personalContext({ userId: otherUserId }) })
      .mockResolvedValueOnce({}) // hasActiveGrant fallback
    const res = await makeApp().request(`/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    })
    expect(res.status).toBe(404)
    expect(mockSqsSend).not.toHaveBeenCalled()
  })
})
