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
    },
    s3: { audioBucket: 'heediq-audio', presignedUrlExpiresIn: 900 },
    sqs: { transcriptionQueueUrl: 'https://sqs/transcription', summarizationQueueUrl: 'https://sqs/summarization' },
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
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Sprint planning' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { ok: boolean; data: { source: { title: string } } }
    expect(body.data.source.title).toBe('Sprint planning')
  })

  it('rejects empty title', async () => {
    const res = await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    })
    expect(res.status).toBe(400)
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

describe('PATCH /:id — org isolation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keys the Update by orgId + sourceId and updates the title', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Attributes: { sourceId: uuid, orgId: orgId, userId: userId, title: 'New', status: 'ready', labels: [], createdAt: now, updatedAt: now },
    })
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

  it('returns 404 when the conditional check fails (wrong org or missing source)', async () => {
    mockDynamoSend.mockRejectedValueOnce(Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' }))
    const res = await makeApp().request(`/${uuid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /:id — org isolation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keys the Update by orgId + sourceId', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp().request(`/${uuid}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ Key: { orgId, sourceId: uuid } }) }),
    )
  })

  it('returns 404 when the conditional check fails (wrong org or missing source)', async () => {
    mockDynamoSend.mockRejectedValueOnce(Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' }))
    const res = await makeApp().request(`/${uuid}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
