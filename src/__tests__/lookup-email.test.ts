import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockDynamoSend = vi.hoisted(() => vi.fn())

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

import { authRouter } from '../routes/auth.js'

const app = new Hono()
app.route('/', authRouter)

const now = new Date().toISOString()

describe('POST /auth/lookup-email (D-078)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('rejects an invalid email', async () => {
    const res = await app.request('/lookup-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns exists:false, passwordSet:null when no user matches', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    const res = await app.request('/lookup-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { exists: boolean; passwordSet: boolean | null } }
    expect(body.data).toEqual({ exists: false, passwordSet: null })
  })

  it('returns exists:true, passwordSet:true for a native account', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ userId: 'u1', orgId: '00000000-0000-0000-0000-000000000002', email: 'a@b.com', role: 'member', passwordSet: true, createdAt: now }],
    })
    const res = await app.request('/lookup-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { exists: boolean; passwordSet: boolean | null } }
    expect(body.data).toEqual({ exists: true, passwordSet: true })
  })

  it('returns exists:true, passwordSet:false for a federated-only account', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ userId: 'u2', orgId: '00000000-0000-0000-0000-000000000002', email: 'fed@b.com', role: 'member', passwordSet: false, createdAt: now }],
    })
    const res = await app.request('/lookup-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'fed@b.com' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { exists: boolean; passwordSet: boolean | null } }
    expect(body.data).toEqual({ exists: true, passwordSet: false })
  })

  it('normalizes email casing/whitespace before querying', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    await app.request('/lookup-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: '  A@B.COM  ' }),
    })
    const call = mockDynamoSend.mock.calls[0]?.[0]
    expect(call.input.ExpressionAttributeValues[':email']).toBe('a@b.com')
  })
})
