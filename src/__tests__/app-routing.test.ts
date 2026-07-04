import { describe, it, expect, vi, beforeEach } from 'vitest'

// D-088 regression: earlier route tests only ever mounted a sub-router (e.g. authRouter) at '/'
// in isolation, which hid the real /api/v1 prefix mismatch that shipped to production as a 404
// on POST /auth/lookup-email. This suite imports the actual top-level `app` export so the mount
// path is exercised exactly as it runs in Lambda.

const mockDynamoSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    cognito: { userPoolId: 'eu-west-1_test', clientId: 'test-client-id', region: 'eu-west-1' },
    dynamo: {
      sourcesTable: 'heediq-sources',
      orgsTable: 'heediq-orgs',
      usersTable: 'heediq-users',
      jobsTable: 'heediq-jobs',
      wsConnectionsTable: 'heediq-ws-connections',
      userAuthMethodsTable: 'heediq-user-auth-methods',
      authAuditLogTable: 'heediq-auth-audit-log',
    },
    s3: { audioBucket: 'heediq-audio', presignedUrlExpiresIn: 900 },
    sqs: { transcriptionQueueUrl: 'https://sqs/transcription', summarizationQueueUrl: 'https://sqs/summarization' },
    cors: { origins: [] },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
  jwtVerify: vi.fn().mockRejectedValue(new Error('no token in this suite')),
}))
vi.mock('@aws-sdk/client-sqs', () => ({ SQSClient: vi.fn(() => ({ send: vi.fn() })), SendMessageCommand: vi.fn() }))
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: vi.fn(() => ({})), PutObjectCommand: vi.fn() }))
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }))

const { app } = await import('../app.js')

describe('app routing — /api/v1 prefix contract (D-088)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('serves the unauthenticated auth routes only under /api/v1/auth', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    const res = await app.request('/api/v1/auth/lookup-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' }),
    })
    expect(res.status).toBe(200)
  })

  it('404s the same route without the /api/v1 prefix', async () => {
    const res = await app.request('/auth/lookup-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' }),
    })
    expect(res.status).toBe(404)
  })

  it('404s an unversioned /me the same way an unversioned auth call would', async () => {
    const res = await app.request('/me')
    expect(res.status).toBe(404)
  })

  it('reaches the authenticated /api/v1/me route (401 for missing token, not 404)', async () => {
    const res = await app.request('/api/v1/me')
    expect(res.status).toBe(401)
  })
})
