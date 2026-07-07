import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'

// Mock jose before importing auth middleware
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
  jwtVerify: vi.fn(),
}))

// Mock config to avoid requireEnv errors
vi.mock('../config.js', () => ({
  config: {
    cognito: { userPoolId: 'eu-west-1_testpool', region: 'eu-west-1' },
    dynamo: {
      sourcesTable: 'heediq-sources',
      orgsTable: 'heediq-orgs',
      usersTable: 'heediq-users',
      jobsTable: 'heediq-jobs',
      wsConnectionsTable: 'heediq-ws-connections',
      userAuthMethodsTable: 'heediq-user-auth-methods',
      authAuditLogTable: 'heediq-auth-audit-log',
      rateLimitsTable: 'heediq-rate-limits',
      cognitoIdentitiesTable: 'heediq-cognito-identities',
    },
    s3: { audioBucket: 'heediq-audio', presignedUrlExpiresIn: 900 },
    sqs: { transcriptionQueueUrl: 'https://sqs.eu-west-1/q/transcription', summarizationQueueUrl: 'https://sqs.eu-west-1/q/summarization' },
    cors: { origins: ['http://localhost:5173'] },
  },
}))

import { jwtVerify } from 'jose'

const app = new Hono()
app.use('*', authMiddleware)
app.get('/test', (c) => c.json({ userId: c.get('userId'), orgId: c.get('orgId') }))

describe('authMiddleware', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns 401 when no Authorization header', async () => {
    const res = await app.request('/test')
    expect(res.status).toBe(401)
    const body = await res.json() as { ok: boolean; error: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 401 when Authorization is not Bearer', async () => {
    const res = await app.request('/test', { headers: { Authorization: 'Basic abc' } })
    expect(res.status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(new Error('invalid'))
    const res = await app.request('/test', { headers: { Authorization: 'Bearer bad-token' } })
    expect(res.status).toBe(401)
  })

  // D-099: userId comes from the app-owned `custom:accountId` claim, never the raw Cognito
  // `sub` — `sub` can be repointed onto a different Cognito user by AdminLinkProviderForUser
  // during account linking, so it's not a stable identity key.
  it('sets userId from custom:accountId, not sub, on a valid token', async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {
        sub: 'raw-cognito-sub',
        'custom:accountId': 'account-1',
        'custom:orgId': 'org-1',
        email: 'a@b.com',
        'custom:role': 'member',
      },
      protectedHeader: { alg: 'RS256' },
    } as Awaited<ReturnType<typeof jwtVerify>>)

    const res = await app.request('/test', { headers: { Authorization: 'Bearer valid-token' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { userId: string; orgId: string }
    expect(body.userId).toBe('account-1')
    expect(body.orgId).toBe('org-1')
  })

  it('returns 401 when the token is missing custom:accountId (predates D-099 or minted before first-login provisioning)', async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {
        sub: 'raw-cognito-sub',
        'custom:orgId': 'org-1',
        email: 'a@b.com',
        'custom:role': 'member',
      },
      protectedHeader: { alg: 'RS256' },
    } as Awaited<ReturnType<typeof jwtVerify>>)

    const res = await app.request('/test', { headers: { Authorization: 'Bearer valid-token' } })
    expect(res.status).toBe(401)
    const body = await res.json() as { ok: boolean; error: { code: string; message: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.message).toMatch(/missing required claims/i)
  })

  it('returns 401 when token is missing other required claims (orgId, email, role)', async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { sub: 'user-1', 'custom:accountId': 'account-1' }, // missing orgId, email, role
      protectedHeader: { alg: 'RS256' },
    } as Awaited<ReturnType<typeof jwtVerify>>)

    const res = await app.request('/test', { headers: { Authorization: 'Bearer valid-token' } })
    expect(res.status).toBe(401)
  })
})
