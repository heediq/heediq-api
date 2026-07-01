import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AuthContext } from '../middleware/auth.js'

const mockDynamoSend = vi.hoisted(() => vi.fn())
const mockSqsSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    cognito: { userPoolId: 'eu-west-1_test', region: 'eu-west-1' },
    dynamo: {
      recordingsTable: 'heediq-recordings',
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

import { recordingsRouter } from '../routes/recordings.js'

function makeApp(role: 'admin' | 'member' = 'admin') {
  const app = new Hono<AuthContext>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('orgId', orgId)
    c.set('email', 'a@b.com')
    c.set('role', role)
    await next()
  })
  app.route('/', recordingsRouter)
  return app
}

const now = new Date().toISOString()
const uuid = '00000000-0000-0000-0000-000000000001'
const orgId = '00000000-0000-0000-0000-000000000002'
const userId = '00000000-0000-0000-0000-000000000003'

describe('GET /recordings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns recording list', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ recordingId: uuid, orgId: orgId, userId: userId, title: 'T', status: 'ready', createdAt: now, updatedAt: now }],
    })
    const res = await makeApp().request('/')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { recordings: unknown[] } }
    expect(body.ok).toBe(true)
    expect(body.data.recordings).toHaveLength(1)
  })
})

describe('POST /recordings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a recording', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Sprint planning' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { ok: boolean; data: { recording: { title: string } } }
    expect(body.data.recording.title).toBe('Sprint planning')
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

  it('returns recording for correct org', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { recordingId: uuid, orgId: orgId, userId: userId, title: 'T', status: 'ready', createdAt: now, updatedAt: now },
    })
    const res = await makeApp().request(`/${uuid}`)
    expect(res.status).toBe(200)
  })

  it('returns 404 when recording belongs to different org', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { recordingId: uuid, orgId: '00000000-0000-0000-0000-000000000099', userId: userId, title: 'T', status: 'ready', createdAt: now, updatedAt: now },
    })
    const res = await makeApp().request(`/${uuid}`)
    expect(res.status).toBe(404)
  })

  it('returns 404 when recording does not exist', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: undefined })
    const res = await makeApp().request(`/${uuid}`)
    expect(res.status).toBe(404)
  })
})

describe('POST /:id/jobs — D-060 access control', () => {
  beforeEach(() => vi.clearAllMocks())

  it('allows small model for free tier', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { recordingId: uuid, orgId: orgId, audioS3Key: 'key' } })
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'free' } })
      .mockResolvedValueOnce({})
    mockSqsSend.mockResolvedValueOnce({})

    const res = await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingId: uuid, model: 'small' }),
    })
    expect(res.status).toBe(201)
  })

  it('sets the tier SQS message attribute — required for the EventBridge Pipe filter to route the job', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { recordingId: uuid, orgId: orgId, audioS3Key: 'key' } })
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'free' } })
      .mockResolvedValueOnce({})
    mockSqsSend.mockResolvedValueOnce({})

    await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingId: uuid, model: 'small' }),
    })

    expect(mockSqsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageAttributes: { tier: { DataType: 'String', StringValue: 'free' } },
      }),
    )
  })

  it('rejects large-v3 for free tier (D-060)', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { recordingId: uuid, orgId: orgId, audioS3Key: 'key' } })
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'free' } })

    const res = await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingId: uuid, model: 'large-v3' }),
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { ok: boolean; error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('allows large-v3 for paid tier (D-060)', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { recordingId: uuid, orgId: orgId, audioS3Key: 'key' } })
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'paid' } })
      .mockResolvedValueOnce({})
    mockSqsSend.mockResolvedValueOnce({})

    const res = await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingId: uuid, model: 'large-v3' }),
    })
    expect(res.status).toBe(201)
  })

  it('returns 404 when recording is from different org', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { recordingId: uuid, orgId: '00000000-0000-0000-0000-000000000099', audioS3Key: 'key' } })
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'free' } })

    const res = await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingId: uuid, model: 'small' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 when no audio uploaded yet', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { recordingId: uuid, orgId: orgId } }) // no audioS3Key
      .mockResolvedValueOnce({ Item: { orgId: orgId, plan: 'free' } })

    const res = await makeApp().request(`/${uuid}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingId: uuid, model: 'small' }),
    })
    expect(res.status).toBe(400)
  })
})
