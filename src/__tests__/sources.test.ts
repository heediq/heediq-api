import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED, type Permission } from '@heediq/shared'
import type { AuthContext } from '../middleware/auth.js'

const mockDynamoSend = vi.hoisted(() => vi.fn())
const mockSqsSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    cognito: { userPoolId: 'eu-west-1_test', region: 'eu-west-1' },
    dynamo: {
      sourcesTable: 'heediq-sources',
      orgsTable: 'heediq-orgs',
      usersTable: 'heediq-users',
      jobsTable: 'heediq-jobs',
      wsConnectionsTable: 'heediq-ws-connections',
      contextsTable: 'heediq-contexts',
      extractedItemsTable: 'heediq-extracted-items',
      roleAssignmentsTable: 'heediq-role-assignments',
      auditLogTable: 'heediq-audit-log',
    },
    s3: { audioBucket: 'heediq-audio', presignedUrlExpiresIn: 900 },
    sqs: { transcriptionQueueUrl: 'https://sqs/transcription', summarizationQueueUrl: 'https://sqs/summarization', ledgerQueueUrl: 'https://sqs/ledger' },
    cors: { origins: [] },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(() => ({ send: mockSqsSend })),
  SendMessageCommand: vi.fn((input) => input),
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: vi.fn() })),
  PutObjectCommand: vi.fn((input) => input),
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.presigned.url'),
}))

import { sourcesRouter } from '../routes/sources.js'

function makeApp(role: 'admin' | 'member' = 'admin', permissions?: Permission[]) {
  const app = new Hono<AuthContext>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('orgId', orgId)
    c.set('email', 'a@b.com')
    c.set('role', role)
    c.set('permissions', permissions ?? [...DEFAULT_ORG_RBAC_SEED[role].permissions])
    await next()
  })
  app.route('/', sourcesRouter)
  return app
}

const now = new Date().toISOString()
const uuid = '00000000-0000-0000-0000-000000000001'
const orgId = '00000000-0000-0000-0000-000000000002'
const userId = '00000000-0000-0000-0000-000000000003'

describe('GET /sources', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns source list', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ sourceId: uuid, orgId: orgId, userId: userId, title: 'T', status: 'ready', labels: [], createdAt: now, updatedAt: now }],
    })
    const res = await makeApp().request('/')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { sources: unknown[] } }
    expect(body.ok).toBe(true)
    expect(body.data.sources).toHaveLength(1)
  })

  it('queries the by-org-created GSI, not the nonexistent by-org index', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    await makeApp().request('/')
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ IndexName: 'by-org-created' }) }),
    )
  })

  it('scopes to own sources for a member caller (permission-derived, not the role name)', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    await makeApp('member').request('/')
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          FilterExpression: 'userId = :userId',
          ExpressionAttributeValues: expect.objectContaining({ ':userId': userId }),
        }),
      }),
    )
  })

  it('scopes to own sources for a custom role with only sources:read-own (D-102 Phase 4 regression) — the filter follows the granted permission, not a hardcoded "member" role check', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    await makeApp('member', ['sources:read-own', 'sources:create']).request('/')
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          FilterExpression: 'userId = :userId',
          ExpressionAttributeValues: expect.objectContaining({ ':userId': userId }),
        }),
      }),
    )
  })

  it('does not scope to own sources for a custom role granted org-wide sources:read', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    await makeApp('member', ['sources:read']).request('/')
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ FilterExpression: undefined }),
      }),
    )
  })
})

describe('POST /sources', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a source', async () => {
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand — create source
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand — audit event (D-107)
    const res = await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Sprint planning' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { ok: boolean; data: { source: { title: string } } }
    expect(body.data.source.title).toBe('Sprint planning')
  })

  it('writes a source:create audit event with the actor as owner (D-107)', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    mockDynamoSend.mockResolvedValueOnce({})
    await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Sprint planning' }),
    })
    expect(mockDynamoSend).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        input: expect.objectContaining({
          Item: expect.objectContaining({
            resourceType: 'source',
            action: 'source:create',
            after: expect.objectContaining({ title: 'Sprint planning', ownerEmail: 'a@b.com' }),
          }),
        }),
      }),
    )
  })

  it('rejects empty title', async () => {
    const res = await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 403 without sources:create permission (D-107)', async () => {
    const res = await makeApp('member', []).request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Sprint planning' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('GET /:id — org isolation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns source for correct org', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { sourceId: uuid, orgId: orgId, userId: userId, title: 'T', status: 'ready', labels: [], createdAt: now, updatedAt: now },
    })
    const res = await makeApp().request(`/${uuid}`)
    expect(res.status).toBe(200)
  })

  it('keys the Get by orgId + sourceId (composite key, not sourceId alone)', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { sourceId: uuid, orgId: orgId, userId: userId, title: 'T', status: 'ready', labels: [], createdAt: now, updatedAt: now },
    })
    await makeApp().request(`/${uuid}`)
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ Key: { orgId, sourceId: uuid } }) }),
    )
  })

  it('returns 404 when source belongs to a different org — Key lookup with the wrong orgId finds nothing', async () => {
    // Real DynamoDB: Key={orgId: <this org>, sourceId} simply doesn't match an item that
    // lives under a different org's partition, so the Get returns no Item — never a
    // cross-org Item to filter out client-side.
    mockDynamoSend.mockResolvedValueOnce({ Item: undefined })
    const res = await makeApp().request(`/${uuid}`)
    expect(res.status).toBe(404)
  })

  it('returns 404 when source does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: undefined })
    const res = await makeApp().request(`/${uuid}`)
    expect(res.status).toBe(404)
  })
})

describe('GET /:id/items — extracted items', () => {
  beforeEach(() => vi.clearAllMocks())

  const item = {
    itemId: '00000000-0000-0000-0000-000000000010',
    sourceId: uuid,
    orgId,
    category: 'requirements',
    text: 'The export must be CSV',
    confidence: 0.9,
    status: 'proposed' as const,
    createdAt: now,
  }

  it('returns the source’s extracted items', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { sourceId: uuid, orgId, userId, title: 'T', status: 'ready', labels: [], createdAt: now, updatedAt: now } }) // source Get
      .mockResolvedValueOnce({ Items: [item] }) // items Query
    const res = await makeApp().request(`/${uuid}/items`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { items: { itemId: string }[] } }
    expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0]!.itemId).toBe(item.itemId)
  })

  it('gates on the org-keyed source first, then queries items by sourceId', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { sourceId: uuid, orgId, userId, title: 'T', status: 'ready', labels: [], createdAt: now, updatedAt: now } })
      .mockResolvedValueOnce({ Items: [] })
    await makeApp().request(`/${uuid}/items`)
    expect(mockDynamoSend).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ input: expect.objectContaining({ Key: { orgId, sourceId: uuid } }) }),
    )
    expect(mockDynamoSend).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ input: expect.objectContaining({ ExpressionAttributeValues: { ':sourceId': uuid } }) }),
    )
  })

  it('404s for a source in another org without ever reading items', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: undefined }) // source Get misses
    const res = await makeApp().request(`/${uuid}/items`)
    expect(res.status).toBe(404)
    expect(mockDynamoSend).toHaveBeenCalledTimes(1) // no item Query on a 404
  })
})

describe('POST /:id/jobs — D-060 access control', () => {
  beforeEach(() => vi.clearAllMocks())

  it('allows small model for free tier', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { sourceId: uuid, orgId: orgId, audioS3Key: 'key' } })
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'free' } })
      .mockResolvedValueOnce({})
    mockSqsSend.mockResolvedValueOnce({})

    const res = await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: uuid, model: 'small' }),
    })
    expect(res.status).toBe(201)
  })

  it('sets the tier SQS message attribute — required for the EventBridge Pipe filter to route the job', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { sourceId: uuid, orgId: orgId, audioS3Key: 'key' } })
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'free' } })
      .mockResolvedValueOnce({})
    mockSqsSend.mockResolvedValueOnce({})

    await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: uuid, model: 'small' }),
    })

    expect(mockSqsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageAttributes: { tier: { DataType: 'String', StringValue: 'free' } },
      }),
    )
  })

  it('rejects large-v3 for free tier (D-060)', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { sourceId: uuid, orgId: orgId, audioS3Key: 'key' } })
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'free' } })

    const res = await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: uuid, model: 'large-v3' }),
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { ok: boolean; error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('allows large-v3 for paid tier (D-060)', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { sourceId: uuid, orgId: orgId, audioS3Key: 'key' } })
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'paid' } })
      .mockResolvedValueOnce({})
    mockSqsSend.mockResolvedValueOnce({})

    const res = await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: uuid, model: 'large-v3' }),
    })
    expect(res.status).toBe(201)
  })

  it('returns 404 when source is from a different org — Key lookup with the wrong orgId finds nothing', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'free' } })

    const res = await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: uuid, model: 'small' }),
    })
    expect(res.status).toBe(404)
  })

  it('keys the source Get by orgId + sourceId', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { sourceId: uuid, orgId: orgId, audioS3Key: 'key' } })
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'free' } })
      .mockResolvedValueOnce({})
    mockSqsSend.mockResolvedValueOnce({})

    await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: uuid, model: 'small' }),
    })

    expect(mockDynamoSend).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ input: expect.objectContaining({ Key: { orgId, sourceId: uuid } }) }),
    )
  })

  it('returns 400 when no audio uploaded yet', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { sourceId: uuid, orgId: orgId } }) // no audioS3Key
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'free' } })

    const res = await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: uuid, model: 'small' }),
    })
    expect(res.status).toBe(400)
  })

  it('writes the job item keyed by sourceId (heediq-jobs has no jobId key attribute)', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { sourceId: uuid, orgId: orgId, audioS3Key: 'key' } })
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'free' } })
      .mockResolvedValueOnce({})
    mockSqsSend.mockResolvedValueOnce({})

    await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: uuid, model: 'small' }),
    })

    expect(mockDynamoSend).toHaveBeenNthCalledWith(3,
      expect.objectContaining({ input: expect.objectContaining({ Item: expect.objectContaining({ sourceId: uuid }) }) }),
    )
  })
})

const existingSource = {
  sourceId: uuid, orgId: orgId, userId: userId, title: 'Old', status: 'ready' as const,
  labels: [], createdAt: now, updatedAt: now,
}

describe('PATCH /:id — org isolation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keys the Update by orgId + sourceId and updates the title', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: existingSource }) // GetCommand — before-state
    mockDynamoSend.mockResolvedValueOnce({
      Attributes: { sourceId: uuid, orgId: orgId, userId: userId, title: 'New', status: 'ready', labels: [], createdAt: now, updatedAt: now },
    }) // UpdateCommand
    mockDynamoSend.mockResolvedValueOnce({ Item: { email: 'owner@heediq.com' } }) // GetCommand — resolveOwnerEmail
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand — audit event (D-107)
    const res = await makeApp().request(`/${uuid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New' }),
    })
    expect(res.status).toBe(200)
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ Key: { orgId, sourceId: uuid } }) }),
    )
  })

  it('writes a source:update audit event with before/after titles (D-107)', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: existingSource })
    mockDynamoSend.mockResolvedValueOnce({
      Attributes: { sourceId: uuid, orgId: orgId, userId: userId, title: 'New', status: 'ready', labels: [], createdAt: now, updatedAt: now },
    })
    mockDynamoSend.mockResolvedValueOnce({ Item: { email: 'owner@heediq.com' } })
    mockDynamoSend.mockResolvedValueOnce({})
    await makeApp().request(`/${uuid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New' }),
    })
    expect(mockDynamoSend).toHaveBeenNthCalledWith(4,
      expect.objectContaining({
        input: expect.objectContaining({
          Item: expect.objectContaining({
            resourceType: 'source',
            action: 'source:update',
            before: expect.objectContaining({ title: 'Old', ownerEmail: 'owner@heediq.com' }),
            after: expect.objectContaining({ title: 'New', ownerEmail: 'owner@heediq.com' }),
          }),
        }),
      }),
    )
  })

  it('returns 404 when the source does not exist (wrong org or missing source)', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: undefined })
    const res = await makeApp().request(`/${uuid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the conditional check fails on update (race after existence check)', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: existingSource })
    mockDynamoSend.mockRejectedValueOnce(Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' }))
    const res = await makeApp().request(`/${uuid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 403 without sources:update permission (D-107)', async () => {
    const res = await makeApp('member', []).request(`/${uuid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('DELETE /:id — org isolation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keys the Update by orgId + sourceId', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: existingSource }) // GetCommand — before-state
    mockDynamoSend.mockResolvedValueOnce({}) // UpdateCommand — soft-delete
    mockDynamoSend.mockResolvedValueOnce({ Item: { email: 'owner@heediq.com' } }) // GetCommand — resolveOwnerEmail
    mockDynamoSend.mockResolvedValueOnce({}) // PutCommand — audit event (D-107)
    const res = await makeApp().request(`/${uuid}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ Key: { orgId, sourceId: uuid } }) }),
    )
  })

  it('writes a source:delete audit event with before-only payload (D-107)', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: existingSource })
    mockDynamoSend.mockResolvedValueOnce({})
    mockDynamoSend.mockResolvedValueOnce({ Item: { email: 'owner@heediq.com' } })
    mockDynamoSend.mockResolvedValueOnce({})
    await makeApp().request(`/${uuid}`, { method: 'DELETE' })
    expect(mockDynamoSend).toHaveBeenNthCalledWith(4,
      expect.objectContaining({
        input: expect.objectContaining({
          Item: expect.objectContaining({
            resourceType: 'source',
            action: 'source:delete',
            before: expect.objectContaining({ title: 'Old', ownerEmail: 'owner@heediq.com' }),
            after: undefined,
          }),
        }),
      }),
    )
  })

  it('returns 404 when the source does not exist (wrong org or missing source)', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: undefined })
    const res = await makeApp().request(`/${uuid}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the conditional check fails on delete (race after existence check)', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: existingSource })
    mockDynamoSend.mockRejectedValueOnce(Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' }))
    const res = await makeApp().request(`/${uuid}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('returns 403 without sources:delete permission (D-107)', async () => {
    const res = await makeApp('member', []).request(`/${uuid}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
  })
})

const reviewContextId = '00000000-0000-0000-0000-000000000050'
const keptItemId = '00000000-0000-0000-0000-000000000060'
const discardedItemId = '00000000-0000-0000-0000-000000000061'

const reviewableContext = {
  contextId: reviewContextId, orgId, userId, domain: 'work' as const, name: 'Ctx',
  visibility: 'personal' as const, status: 'active' as const, createdAt: now, updatedAt: now,
}

const extractedItems = [
  { itemId: keptItemId, sourceId: uuid, orgId, category: 'decision', text: 'Kept item', confidence: 0.9, status: 'proposed' as const, createdAt: now },
  { itemId: discardedItemId, sourceId: uuid, orgId, category: 'decision', text: 'Discarded item', confidence: 0.5, status: 'proposed' as const, createdAt: now },
]

describe('POST /:id/review', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects an invalid body', async () => {
    const res = await makeApp().request(`/${uuid}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 403 without sources:update permission', async () => {
    const res = await makeApp('member', []).request(`/${uuid}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId: reviewContextId, kept: [keptItemId] }),
    })
    expect(res.status).toBe(403)
  })

  it('returns 404 when the source does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({}) // GetCommand — source
    const res = await makeApp().request(`/${uuid}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId: reviewContextId, kept: [keptItemId] }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 when the context does not exist or is not visible to the caller', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: existingSource }) // GetCommand — source
    mockDynamoSend.mockResolvedValueOnce({}) // GetCommand — context, no Item
    const res = await makeApp().request(`/${uuid}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId: reviewContextId, kept: [keptItemId] }),
    })
    expect(res.status).toBe(400)
  })

  it('marks kept items kept+filed and non-kept items discarded, sets Source classification, and audits after-only', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: existingSource }) // GetCommand — source
    mockDynamoSend.mockResolvedValueOnce({ Item: reviewableContext }) // GetCommand — context
    mockDynamoSend.mockResolvedValueOnce({ Items: extractedItems }) // QueryCommand — extracted items
    mockDynamoSend.mockResolvedValueOnce({}) // UpdateCommand — kept item
    mockDynamoSend.mockResolvedValueOnce({}) // UpdateCommand — discarded item
    mockDynamoSend.mockResolvedValueOnce({}) // UpdateCommand — source classification
    mockDynamoSend.mockResolvedValueOnce({}) // audit PutCommand
    mockDynamoSend.mockResolvedValueOnce({ Item: { orgId, plan: 'paid' } }) // GetCommand — org plan (ledger tier)
    mockSqsSend.mockResolvedValueOnce({})

    const res = await makeApp().request(`/${uuid}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId: reviewContextId, kept: [keptItemId] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { keptCount: number; discardedCount: number } }
    expect(body.data.keptCount).toBe(1)
    expect(body.data.discardedCount).toBe(1)
    expect(mockDynamoSend).toHaveBeenCalledTimes(8)
    expect(mockDynamoSend).toHaveBeenNthCalledWith(7,
      expect.objectContaining({
        input: expect.objectContaining({
          Item: expect.objectContaining({
            resourceType: 'extractedItemReview',
            action: 'source:review',
            after: expect.objectContaining({ sourceId: uuid, contextId: reviewContextId, keptCount: 1, discardedCount: 1 }),
            before: undefined,
          }),
        }),
      }),
    )
    // D-148: a ledger reconciliation job is enqueued for the filed items.
    expect(mockSqsSend).toHaveBeenCalledOnce()
    const job = JSON.parse(mockSqsSend.mock.calls[0][0].MessageBody)
    expect(mockSqsSend.mock.calls[0][0].QueueUrl).toBe('https://sqs/ledger')
    expect(job).toMatchObject({ contextId: reviewContextId, sourceId: uuid, orgId, tier: 'paid' })
  })

  it('does not enqueue a ledger job when nothing was kept (D-148)', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: existingSource }) // source
    mockDynamoSend.mockResolvedValueOnce({ Item: reviewableContext }) // context
    mockDynamoSend.mockResolvedValueOnce({ Items: extractedItems }) // items
    mockDynamoSend.mockResolvedValueOnce({}) // discard item 1
    mockDynamoSend.mockResolvedValueOnce({}) // discard item 2
    mockDynamoSend.mockResolvedValueOnce({}) // source classification
    mockDynamoSend.mockResolvedValueOnce({}) // audit

    const res = await makeApp().request(`/${uuid}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId: reviewContextId, kept: [] }),
    })
    expect(res.status).toBe(200)
    expect(mockSqsSend).not.toHaveBeenCalled()
    expect(mockDynamoSend).toHaveBeenCalledTimes(7) // no org-plan lookup either
  })

  it('still returns 200 when the ledger enqueue fails — review is already committed (D-148 best-effort)', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: existingSource }) // source
    mockDynamoSend.mockResolvedValueOnce({ Item: reviewableContext }) // context
    mockDynamoSend.mockResolvedValueOnce({ Items: extractedItems }) // items
    mockDynamoSend.mockResolvedValueOnce({}) // kept
    mockDynamoSend.mockResolvedValueOnce({}) // discarded
    mockDynamoSend.mockResolvedValueOnce({}) // classification
    mockDynamoSend.mockResolvedValueOnce({}) // audit
    mockDynamoSend.mockResolvedValueOnce({ Item: { orgId, plan: 'free' } }) // org plan
    mockSqsSend.mockRejectedValueOnce(new Error('SQS unavailable'))

    const res = await makeApp().request(`/${uuid}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId: reviewContextId, kept: [keptItemId] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { keptCount: number } }
    expect(body.data.keptCount).toBe(1)
  })
})

describe('POST /:id/text — text-file ingest (D-150 / D-065)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 403 without sources:create permission', async () => {
    const res = await makeApp('member', []).request(`/${uuid}/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Some notes' }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects an empty text body', async () => {
    const res = await makeApp().request(`/${uuid}/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when the source is missing or from another org', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: undefined }) // source Get misses
      .mockResolvedValueOnce({ Item: { orgId, plan: 'free' } }) // org Get (runs in the same Promise.all)
    const res = await makeApp().request(`/${uuid}/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Some notes' }),
    })
    expect(res.status).toBe(404)
  })

  it('writes the transcript onto the source (status→processing, sourceType→text) then enqueues a summarization job', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: existingSource }) // source Get
      .mockResolvedValueOnce({ Item: { orgId, plan: 'free' } }) // org Get
      .mockResolvedValueOnce({}) // UpdateCommand — transcript write
    mockSqsSend.mockResolvedValueOnce({})

    const res = await makeApp().request(`/${uuid}/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'The export must be CSV.' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { data: { jobId: string } }
    expect(body.data.jobId).toBeTruthy()

    // Transcript + status/sourceType committed on the org-keyed source row before enqueue.
    expect(mockDynamoSend).toHaveBeenNthCalledWith(3,
      expect.objectContaining({
        input: expect.objectContaining({
          Key: { orgId, sourceId: uuid },
          ExpressionAttributeValues: expect.objectContaining({
            ':transcript': 'The export must be CSV.',
            ':status': 'processing',
            ':sourceType': 'text',
          }),
        }),
      }),
    )

    // Enqueued to the summarization queue with sourceType='text' and contentRef=sourceId (the
    // worker reads the transcript off the source row — D-065), plus the tier message attribute.
    expect(mockSqsSend).toHaveBeenCalledOnce()
    const call = mockSqsSend.mock.calls[0][0]
    expect(call.QueueUrl).toBe('https://sqs/summarization')
    expect(call.MessageAttributes).toEqual({ tier: { DataType: 'String', StringValue: 'free' } })
    const message = JSON.parse(call.MessageBody)
    expect(message).toMatchObject({ sourceType: 'text', contentRef: uuid, sourceId: uuid, orgId, tier: 'free' })
  })

  it('stamps the org plan tier onto the job (paid)', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: existingSource })
      .mockResolvedValueOnce({ Item: { orgId, plan: 'paid' } })
      .mockResolvedValueOnce({})
    mockSqsSend.mockResolvedValueOnce({})

    await makeApp().request(`/${uuid}/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Notes' }),
    })
    const message = JSON.parse(mockSqsSend.mock.calls[0][0].MessageBody)
    expect(message.tier).toBe('paid')
    expect(mockSqsSend.mock.calls[0][0].MessageAttributes.tier.StringValue).toBe('paid')
  })

  it('returns 404 when the transcript write loses a create→delete race (conditional check fails)', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: existingSource })
      .mockResolvedValueOnce({ Item: { orgId, plan: 'free' } })
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' }))
    const res = await makeApp().request(`/${uuid}/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Notes' }),
    })
    expect(res.status).toBe(404)
    expect(mockSqsSend).not.toHaveBeenCalled()
  })

  it('marks the source failed and 500s when the enqueue fails after the transcript is committed', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: existingSource }) // source Get
      .mockResolvedValueOnce({ Item: { orgId, plan: 'free' } }) // org Get
      .mockResolvedValueOnce({}) // transcript write
      .mockResolvedValueOnce({}) // status→failed rollback
    mockSqsSend.mockRejectedValueOnce(new Error('SQS unavailable'))

    const res = await makeApp().request(`/${uuid}/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Notes' }),
    })
    expect(res.status).toBe(500)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INTERNAL_ERROR')
    // The source was flipped to `failed` so it doesn't sit stuck in `processing`.
    expect(mockDynamoSend).toHaveBeenNthCalledWith(4,
      expect.objectContaining({
        input: expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({ ':status': 'failed' }),
        }),
      }),
    )
  })
})
