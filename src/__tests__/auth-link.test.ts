import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockDynamoSend = vi.hoisted(() => vi.fn())
const mockSignUp = vi.hoisted(() => vi.fn())
const mockResendConfirmationCode = vi.hoisted(() => vi.fn())
const mockConfirmSignUp = vi.hoisted(() => vi.fn())
const mockAdminSetUserPassword = vi.hoisted(() => vi.fn())
const mockAdminLinkProviderForUser = vi.hoisted(() => vi.fn())
const mockAdminDeleteUser = vi.hoisted(() => vi.fn())
const mockListUsersByEmail = vi.hoisted(() => vi.fn())
const mockCheckRateLimit = vi.hoisted(() => vi.fn())

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
      rateLimitsTable: 'heediq-rate-limits',
      cognitoIdentitiesTable: 'heediq-cognito-identities',
    },
    s3: { audioBucket: 'heediq-audio', presignedUrlExpiresIn: 900 },
    sqs: { transcriptionQueueUrl: 'https://sqs/transcription', summarizationQueueUrl: 'https://sqs/summarization' },
    cors: { origins: [] },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

vi.mock('../lib/rateLimit.js', () => ({ checkRateLimit: mockCheckRateLimit }))

vi.mock('../lib/cognito.js', () => ({
  signUp: mockSignUp,
  resendConfirmationCode: mockResendConfirmationCode,
  confirmSignUp: mockConfirmSignUp,
  adminSetUserPassword: mockAdminSetUserPassword,
  adminLinkProviderForUser: mockAdminLinkProviderForUser,
  adminDeleteUser: mockAdminDeleteUser,
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
  beforeEach(() => {
    vi.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(false)
  })

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

  it('falls through to resend when the user already exists mid-flow (UNCONFIRMED)', async () => {
    mockSignUp.mockRejectedValueOnce(awsError('UsernameExistsException'))
    mockListUsersByEmail.mockResolvedValueOnce([{ Username: 'existing@b.com', UserStatus: 'UNCONFIRMED' }])
    mockResendConfirmationCode.mockResolvedValueOnce({})
    const res = await app.request('/link/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'existing@b.com' }),
    })
    expect(res.status).toBe(200)
    expect(mockResendConfirmationCode).toHaveBeenCalledWith('existing@b.com')
    expect(mockAdminDeleteUser).not.toHaveBeenCalled()
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
    mockListUsersByEmail.mockResolvedValueOnce([])
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
    mockListUsersByEmail.mockResolvedValueOnce([])
    mockResendConfirmationCode.mockRejectedValueOnce(awsError('NotAuthorizedException'))
    const res = await app.request('/link/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' }),
    })
    expect(res.status).toBe(200)
  })

  // D-096: a user who verified the code but abandoned before setting a password is left as a
  // native Cognito user stuck CONFIRMED with no password — Cognito refuses to resend a code to
  // a CONFIRMED user, so without this heal the account would be unrecoverable via self-service.
  it('heals a stuck confirmed-but-unlinked native user by deleting and re-signing-up', async () => {
    mockSignUp.mockRejectedValueOnce(awsError('UsernameExistsException'))
    mockListUsersByEmail.mockResolvedValueOnce([{ Username: 'stuck-sub', UserStatus: 'CONFIRMED' }])
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }) // no passwordSet=true row — never linked
    mockSignUp.mockResolvedValueOnce({}) // fresh SignUp after the heal

    const res = await app.request('/link/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'stuck@b.com' }),
    })
    expect(res.status).toBe(200)
    expect(mockAdminDeleteUser).toHaveBeenCalledWith('stuck-sub')
    expect(mockSignUp).toHaveBeenCalledTimes(2)
    expect(mockResendConfirmationCode).not.toHaveBeenCalled()
  })

  it('does not heal a real already-linked account (passwordSet true)', async () => {
    mockSignUp.mockRejectedValueOnce(awsError('UsernameExistsException'))
    mockListUsersByEmail.mockResolvedValueOnce([{ Username: 'linked-sub', UserStatus: 'CONFIRMED' }])
    mockDynamoSend.mockResolvedValueOnce({ Items: [{ userId: 'linked-sub', email: 'linked@b.com', passwordSet: true, orgId: '11111111-1111-4111-8111-111111111111', role: 'member', createdAt: '2026-01-01T00:00:00.000Z' }] })
    mockResendConfirmationCode.mockRejectedValueOnce(awsError('InvalidParameterException'))

    const res = await app.request('/link/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'linked@b.com' }),
    })
    expect(res.status).toBe(200)
    expect(mockAdminDeleteUser).not.toHaveBeenCalled()
    expect(mockResendConfirmationCode).toHaveBeenCalledWith('linked@b.com')
  })

  it('returns 429 when the post-heal SignUp is rate-limited', async () => {
    mockSignUp.mockRejectedValueOnce(awsError('UsernameExistsException'))
    mockListUsersByEmail.mockResolvedValueOnce([{ Username: 'stuck-sub', UserStatus: 'CONFIRMED' }])
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    mockSignUp.mockRejectedValueOnce(awsError('LimitExceededException'))

    const res = await app.request('/link/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'stuck@b.com' }),
    })
    expect(res.status).toBe(429)
  })

  // D-097: app-level throttling must reject before Cognito is ever called, so a blocked
  // caller can't burn through Cognito's own SES-backed send quota either.
  it('returns 429 from the app-level limiter without calling Cognito', async () => {
    mockCheckRateLimit.mockResolvedValueOnce(true) // email key trips
    const res = await app.request('/link/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'flooded@b.com' }),
    })
    expect(res.status).toBe(429)
    expect(mockSignUp).not.toHaveBeenCalled()
  })
})

describe('POST /auth/link/verify-otp (D-089)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(false)
  })

  const validBody = { email: 'a@b.com', code: '123456' }

  it('rejects an invalid request body', async () => {
    const res = await app.request('/link/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com', code: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for a genuinely invalid/expired code', async () => {
    mockConfirmSignUp.mockRejectedValueOnce(awsError('CodeMismatchException'))
    const res = await app.request('/link/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(400)
  })

  // Regression for the OTP-bypass bug: this is the endpoint the frontend's code screen must
  // call before it is allowed to advance to the password screen — /link/confirm no longer
  // takes a code at all, so if this check is skipped, no code is ever verified.
  it('verifies a correct code and does not set a password', async () => {
    mockConfirmSignUp.mockResolvedValueOnce({})
    const res = await app.request('/link/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { verified: boolean } }
    expect(body.data).toEqual({ verified: true })
    expect(mockAdminSetUserPassword).not.toHaveBeenCalled()
  })

  // Cognito's ConfirmSignUp throws NotAuthorizedException for any user that isn't UNCONFIRMED
  // — including an already-set-up account (native, or an email alias resolving to an existing
  // EXTERNAL_PROVIDER/IdP-linked user) — regardless of what code was submitted. Any code must
  // be rejected in that case, not treated as "already confirmed, proceed" (which previously
  // let anyone set a password on any known email with no real code check at all).
  it('rejects any code against an already-confirmed/existing account instead of bypassing verification', async () => {
    mockConfirmSignUp.mockRejectedValueOnce(awsError('NotAuthorizedException'))

    const res = await app.request('/link/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(400)
  })

  // D-097: blocks brute-forcing the code itself, not just repeated request-otp calls.
  it('returns 429 from the app-level limiter without calling Cognito', async () => {
    mockCheckRateLimit.mockResolvedValueOnce(true) // IP key trips
    const res = await app.request('/link/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(429)
    expect(mockConfirmSignUp).not.toHaveBeenCalled()
  })
})

describe('POST /auth/link/confirm (D-087, D-089)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const validBody = { email: 'a@b.com', newPassword: 'password123' }

  it('rejects an invalid request body', async () => {
    const res = await app.request('/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com', newPassword: 'short' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when no native user exists to attach the password to', async () => {
    mockListUsersByEmail.mockResolvedValueOnce([{ Username: 'google_123', UserStatus: 'EXTERNAL_PROVIDER' }])

    const res = await app.request('/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(400)
  })

  it('returns WEAK_PASSWORD when Cognito rejects the password on policy grounds', async () => {
    mockListUsersByEmail.mockResolvedValueOnce([{ Username: 'a@b.com', UserStatus: 'CONFIRMED', sub: 'native-sub' }])
    mockAdminSetUserPassword.mockRejectedValueOnce(awsError('InvalidPasswordException'))

    const res = await app.request('/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('WEAK_PASSWORD')
  })

  it('links existing external-provider users to the native account and records the method', async () => {
    mockListUsersByEmail.mockResolvedValueOnce([
      { Username: 'a@b.com', UserStatus: 'CONFIRMED', sub: 'native-sub' },
      { Username: 'Google_g1', UserStatus: 'EXTERNAL_PROVIDER', identities: [{ providerName: 'Google', providerUserId: 'g1' }] },
    ])
    mockAdminSetUserPassword.mockResolvedValueOnce({})
    mockAdminLinkProviderForUser.mockResolvedValueOnce({})
    // Get on the identities table (no mapping yet) -> falls back to the by-email Query.
    mockDynamoSend
      .mockResolvedValueOnce({ Item: undefined }) // resolveAccountIdBySub: Get identities table
      .mockResolvedValueOnce({ Items: [{ userId: 'native-sub' }] }) // resolveAccountIdByEmail: Query by-email
      .mockResolvedValue({}) // linkIdentity Put, method Put, audit Put, passwordSet Update

    const res = await app.request('/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { passwordSet: boolean } }
    expect(body.data).toEqual({ passwordSet: true })
    expect(mockAdminLinkProviderForUser).toHaveBeenCalledWith('a@b.com', 'Google', 'g1')

    // linkIdentity pins the native sub to the resolved canonical accountId (D-099) before
    // recordAuthMethodAndAudit writes under that same accountId.
    const linkPut = mockDynamoSend.mock.calls[2]?.[0] as { input: { TableName: string; Item: Record<string, unknown> } }
    expect(linkPut.input.TableName).toBe('heediq-cognito-identities')
    expect(linkPut.input.Item).toMatchObject({ sub: 'native-sub', accountId: 'native-sub' })
  })

  it('resolves the canonical accountId via the identities table when a mapping already exists, skipping the email guess', async () => {
    mockListUsersByEmail.mockResolvedValueOnce([
      { Username: 'a@b.com', UserStatus: 'CONFIRMED', sub: 'native-sub' },
    ])
    mockAdminSetUserPassword.mockResolvedValueOnce({})
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { sub: 'native-sub', accountId: 'account-1' } }) // resolveAccountIdBySub: hit
      .mockResolvedValue({}) // linkIdentity, method, audit, passwordSet update

    const res = await app.request('/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(200)

    const linkPut = mockDynamoSend.mock.calls[1]?.[0] as { input: { TableName: string; Item: Record<string, unknown> } }
    expect(linkPut.input.TableName).toBe('heediq-cognito-identities')
    expect(linkPut.input.Item).toMatchObject({ sub: 'native-sub', accountId: 'account-1' })

    const methodPut = mockDynamoSend.mock.calls[2]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(methodPut.input.Item['pk']).toBe('USER#account-1')
  })

  it('treats InvalidParameterException on link as already-linked and continues', async () => {
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
