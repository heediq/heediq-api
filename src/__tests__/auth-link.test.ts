import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockDynamoSend = vi.hoisted(() => vi.fn())
const mockSignUp = vi.hoisted(() => vi.fn())
const mockResendConfirmationCode = vi.hoisted(() => vi.fn())
const mockConfirmSignUp = vi.hoisted(() => vi.fn())
const mockAdminSetUserPassword = vi.hoisted(() => vi.fn())
const mockAdminLinkProviderForUser = vi.hoisted(() => vi.fn())
const mockListUsersByEmail = vi.hoisted(() => vi.fn())

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

vi.mock('../lib/cognito.js', () => ({
  signUp: mockSignUp,
  resendConfirmationCode: mockResendConfirmationCode,
  confirmSignUp: mockConfirmSignUp,
  adminSetUserPassword: mockAdminSetUserPassword,
  adminLinkProviderForUser: mockAdminLinkProviderForUser,
  listUsersByEmail: mockListUsersByEmail,
  isExternalProviderUser: (u: { UserStatus?: string }) => u.UserStatus === 'EXTERNAL_PROVIDER',
  getProviderContext: (u: { identities?: { providerName: string; providerUserId: string }[] }) =>
    u.identities?.[0] ? { providerName: u.identities[0].providerName, providerUserId: u.identities[0].providerUserId } : null,
  getUserAttribute: (u: { sub?: string }, name: string) => (name === 'sub' ? u.sub : undefined),
  randomPassword: () => 'Aa9!throwaway',
}))

import { authRouter } from '../routes/auth.js'

const app = new Hono()
app.route('/', authRouter)

function awsError(name: string) {
  const err = new Error(name)
  err.name = name
  return err
}

describe('POST /auth/link/request-otp (D-087)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('rejects an invalid email', async () => {
    const res = await app.request('/link/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    })
    expect(res.status).toBe(400)
  })

  it('signs up a new native user and returns success without revealing account state', async () => {
    mockSignUp.mockResolvedValueOnce({})
    const res = await app.request('/link/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: '  A@B.COM  ' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { sent: boolean } }
    expect(body.data).toEqual({ sent: true })
    expect(mockSignUp).toHaveBeenCalledWith('a@b.com', 'Aa9!throwaway')
    expect(mockResendConfirmationCode).not.toHaveBeenCalled()
  })

  it('falls through to resend when the user already exists mid-flow', async () => {
    mockSignUp.mockRejectedValueOnce(awsError('UsernameExistsException'))
    mockResendConfirmationCode.mockResolvedValueOnce({})
    const res = await app.request('/link/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'existing@b.com' }),
    })
    expect(res.status).toBe(200)
    expect(mockResendConfirmationCode).toHaveBeenCalledWith('existing@b.com')
  })

  it('returns 429 when SignUp is rate-limited', async () => {
    mockSignUp.mockRejectedValueOnce(awsError('LimitExceededException'))
    const res = await app.request('/link/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' }),
    })
    expect(res.status).toBe(429)
  })

  it('returns 429 when the resend fallback is rate-limited', async () => {
    mockSignUp.mockRejectedValueOnce(awsError('UsernameExistsException'))
    mockResendConfirmationCode.mockRejectedValueOnce(awsError('LimitExceededException'))
    const res = await app.request('/link/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' }),
    })
    expect(res.status).toBe(429)
  })

  it('still returns success when resend fails for a benign reason', async () => {
    mockSignUp.mockRejectedValueOnce(awsError('UsernameExistsException'))
    mockResendConfirmationCode.mockRejectedValueOnce(awsError('NotAuthorizedException'))
    const res = await app.request('/link/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' }),
    })
    expect(res.status).toBe(200)
  })
})

describe('POST /auth/link/confirm (D-087)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const validBody = { email: 'a@b.com', code: '123456', newPassword: 'password123' }

  it('rejects an invalid request body', async () => {
    const res = await app.request('/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com', code: '', newPassword: 'short' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for a genuinely invalid/expired code', async () => {
    mockConfirmSignUp.mockRejectedValueOnce(awsError('CodeMismatchException'))
    const res = await app.request('/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(400)
    expect(mockAdminSetUserPassword).not.toHaveBeenCalled()
  })

  // Regression for the OTP-bypass bug: Cognito's ConfirmSignUp throws NotAuthorizedException
  // for any user that isn't UNCONFIRMED — including an already-set-up account (native, or an
  // email alias resolving to an existing EXTERNAL_PROVIDER/IdP-linked user) — regardless of
  // what code was submitted. Any code must be rejected in that case, not treated as "already
  // confirmed, proceed" (which previously let anyone set a password on any known email with no
  // real code check at all).
  it('rejects any code against an already-confirmed/existing account instead of bypassing verification', async () => {
    mockConfirmSignUp.mockRejectedValueOnce(awsError('NotAuthorizedException'))

    const res = await app.request('/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(400)
    expect(mockAdminSetUserPassword).not.toHaveBeenCalled()
  })

  it('returns 400 when no native user exists to attach the password to', async () => {
    mockConfirmSignUp.mockResolvedValueOnce({})
    mockListUsersByEmail.mockResolvedValueOnce([{ Username: 'google_123', UserStatus: 'EXTERNAL_PROVIDER' }])

    const res = await app.request('/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(400)
  })

  it('links existing external-provider users to the native account and records the method', async () => {
    mockConfirmSignUp.mockResolvedValueOnce({})
    mockListUsersByEmail.mockResolvedValueOnce([
      { Username: 'a@b.com', UserStatus: 'CONFIRMED', sub: 'native-sub' },
      { Username: 'Google_g1', UserStatus: 'EXTERNAL_PROVIDER', identities: [{ providerName: 'Google', providerUserId: 'g1' }] },
    ])
    mockAdminSetUserPassword.mockResolvedValueOnce({})
    mockAdminLinkProviderForUser.mockResolvedValueOnce({})
    mockDynamoSend.mockResolvedValue({ Items: [{ userId: 'native-sub' }] })

    const res = await app.request('/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { passwordSet: boolean } }
    expect(body.data).toEqual({ passwordSet: true })
    expect(mockAdminLinkProviderForUser).toHaveBeenCalledWith('a@b.com', 'Google', 'g1')
  })

  it('treats InvalidParameterException on link as already-linked and continues', async () => {
    mockConfirmSignUp.mockResolvedValueOnce({})
    mockListUsersByEmail.mockResolvedValueOnce([
      { Username: 'a@b.com', UserStatus: 'CONFIRMED', sub: 'native-sub' },
      { Username: 'Google_g1', UserStatus: 'EXTERNAL_PROVIDER', identities: [{ providerName: 'Google', providerUserId: 'g1' }] },
    ])
    mockAdminSetUserPassword.mockResolvedValueOnce({})
    mockAdminLinkProviderForUser.mockRejectedValueOnce(awsError('InvalidParameterException'))
    mockDynamoSend.mockResolvedValue({ Items: [] })

    const res = await app.request('/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(200)
  })

  it('returns 409 when the provider is already linked to a different account', async () => {
    mockConfirmSignUp.mockResolvedValueOnce({})
    mockListUsersByEmail.mockResolvedValueOnce([
      { Username: 'a@b.com', UserStatus: 'CONFIRMED', sub: 'native-sub' },
      { Username: 'Google_g1', UserStatus: 'EXTERNAL_PROVIDER', identities: [{ providerName: 'Google', providerUserId: 'g1' }] },
    ])
    mockAdminSetUserPassword.mockResolvedValueOnce({})
    mockAdminLinkProviderForUser.mockRejectedValueOnce(awsError('AliasExistsException'))

    const res = await app.request('/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(409)
  })
})
