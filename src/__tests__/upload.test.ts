import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AuthContext } from '../middleware/auth.js'

const mockDynamoSend = vi.hoisted(() => vi.fn())
const mockGetSignedUrl = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    dynamo: { sourcesTable: 'heediq-sources' },
    s3: { audioBucket: 'heediq-audio', presignedUrlExpiresIn: 900 },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: vi.fn() })),
  PutObjectCommand: vi.fn((input) => input),
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}))

import { uploadRouter } from '../routes/upload.js'

const orgId = '00000000-0000-0000-0000-000000000002'
const sourceId = '00000000-0000-0000-0000-000000000001'

function makeApp() {
  const app = new Hono<AuthContext>()
  app.use('*', async (c, next) => {
    c.set('orgId', orgId)
    await next()
  })
  app.route('/', uploadRouter)
  return app
}

const validBody = { sourceId, contentType: 'audio/webm', fileSizeBytes: 1024 }

describe('POST /upload/presign', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stamps audioS3Key + sourceType=audio on the source, then issues a presigned URL', async () => {
    mockDynamoSend.mockResolvedValueOnce({}) // UpdateCommand — stamp the source row
    mockGetSignedUrl.mockResolvedValueOnce('https://s3.presigned.url')

    const res = await makeApp().request('/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { uploadUrl: string; s3Key: string; expiresIn: number } }
    expect(body.data.uploadUrl).toBe('https://s3.presigned.url')
    expect(body.data.s3Key).toBe(`sources/${orgId}/${sourceId}/audio`)

    expect(mockDynamoSend).toHaveBeenCalledOnce()
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Key: { orgId, sourceId },
          ConditionExpression: 'attribute_exists(sourceId)',
          ExpressionAttributeValues: expect.objectContaining({
            ':key': `sources/${orgId}/${sourceId}/audio`,
            ':sourceType': 'audio',
          }),
        }),
      }),
    )
  })

  it('returns 404 for an unknown or other-org source (conditional check fails) and never mints a URL', async () => {
    mockDynamoSend.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' }),
    )
    const res = await makeApp().request('/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(404)
    expect(mockGetSignedUrl).not.toHaveBeenCalled()
  })

  it('rejects an invalid body before touching DynamoDB', async () => {
    const res = await makeApp().request('/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: 'not-a-uuid', contentType: 'audio/webm', fileSizeBytes: 1 }),
    })
    expect(res.status).toBe(400)
    expect(mockDynamoSend).not.toHaveBeenCalled()
  })
})
