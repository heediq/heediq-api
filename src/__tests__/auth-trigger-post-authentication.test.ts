import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PostAuthenticationTriggerEvent } from 'aws-lambda'

process.env['USERS_TABLE_NAME'] = 'heediq-users'
process.env['USER_AUTH_METHODS_TABLE_NAME'] = 'heediq-user-auth-methods'
process.env['AUTH_AUDIT_LOG_TABLE_NAME'] = 'heediq-auth-audit-log'
process.env['COGNITO_IDENTITIES_TABLE_NAME'] = 'heediq-cognito-identities'

const dynamoSend = vi.fn()
vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: (...args: unknown[]) => dynamoSend(...args) } }))

const cognitoSend = vi.fn()
vi.mock('@aws-sdk/client-cognito-identity-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cognito-identity-provider')>()
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({ send: (...args: unknown[]) => cognitoSend(...args) })),
  }
})

const { handler } = await import('../handlers/auth-trigger-post-authentication.js')

function baseEvent(overrides: Record<string, string> = {}): PostAuthenticationTriggerEvent {
  return {
    triggerSource: 'PostAuthentication_Authentication',
    userPoolId: 'eu-west-1_test',
    userName: 'Google_g1',
    request: {
      userAttributes: { sub: 'ext-sub', email: 'a@b.com', ...overrides },
    },
    response: {},
  } as unknown as PostAuthenticationTriggerEvent
}

describe('auth-trigger-post-authentication handler', () => {
  beforeEach(() => { dynamoSend.mockReset(); cognitoSend.mockReset() })

  it('ignores non-matching trigger sources', async () => {
    const event = { ...baseEvent(), triggerSource: 'PostAuthentication_Authentication_FooBar' } as PostAuthenticationTriggerEvent
    await handler(event, {} as never, () => undefined)
    expect(cognitoSend).not.toHaveBeenCalled()
  })

  it('resolves the canonical accountId via the identities table before the email fallback', async () => {
    dynamoSend
      .mockResolvedValueOnce({ Item: { sub: 'ext-sub', accountId: 'account-1' } }) // Get identities table -> hit
      .mockResolvedValueOnce({}) // Put method
    cognitoSend
      .mockResolvedValueOnce({ Users: [] }) // ListUsers by email — no native user for this email
      .mockResolvedValueOnce({ Users: [{ Username: 'Google_g1', UserStatus: 'EXTERNAL_PROVIDER', Attributes: [{ Name: 'identities', Value: '[{"providerName":"Google","userId":"g1"}]' }] }] }) // ListUsers by sub

    await handler(baseEvent({ identities: '[{"providerName":"Google","userId":"g1"}]' }), {} as never, () => undefined)

    // Identities table hit — no email Query for resolution, no linkIdentity write. No native
    // user exists to link against, so no AdminLinkProviderForUser call either.
    expect(dynamoSend).toHaveBeenCalledTimes(2)
    expect(cognitoSend).toHaveBeenCalledTimes(2)
    const methodPut = dynamoSend.mock.calls[1]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(methodPut.input.Item['pk']).toBe('USER#account-1')
  })

  it('records the method, pins the identity, and auto-links a federated login not yet linked to the native user', async () => {
    dynamoSend
      .mockResolvedValueOnce({ Item: undefined }) // Get identities table -> no mapping
      .mockResolvedValueOnce({ Items: [{ userId: 'native-sub' }] }) // Query by-email -> canonical account
      .mockResolvedValueOnce({}) // Put method
      .mockResolvedValueOnce({}) // Put audit (AUTO_LINK_POST_AUTH)
    cognitoSend
      .mockResolvedValueOnce({ Users: [{ Username: 'a@b.com', UserStatus: 'CONFIRMED', Attributes: [{ Name: 'sub', Value: 'native-sub' }] }] }) // ListUsers by email
      .mockResolvedValueOnce({ Users: [{ Username: 'Google_g1', UserStatus: 'EXTERNAL_PROVIDER', Attributes: [{ Name: 'identities', Value: '[{"providerName":"Google","userId":"g1"}]' }] }] }) // ListUsers by sub
      .mockResolvedValueOnce({}) // AdminLinkProviderForUser

    await handler(baseEvent({ identities: '[{"providerName":"Google","userId":"g1"}]' }), {} as never, () => undefined)

    // resolvedAccountId was found via email (truthy) so no linkIdentity Put — only method + audit.
    expect(dynamoSend).toHaveBeenCalledTimes(4)
    expect(cognitoSend).toHaveBeenCalledTimes(3)
    const linkCall = cognitoSend.mock.calls[2]?.[0] as { input: { SourceUser: { ProviderAttributeValue: string } } }
    expect(linkCall.input.SourceUser.ProviderAttributeValue).toBe('g1')
  })

  it('pins the sub to its resolved accountId via linkIdentity when nothing resolved it up front', async () => {
    dynamoSend
      .mockResolvedValueOnce({ Item: undefined }) // Get identities table -> no mapping
      .mockResolvedValueOnce({ Items: [] }) // Query by-email -> no existing row, fall back to own sub
      .mockResolvedValueOnce({}) // Put linkIdentity
      .mockResolvedValueOnce({}) // Put audit (PROVIDER_CONTEXT_MISSING)
    cognitoSend
      .mockResolvedValueOnce({ Users: [] }) // ListUsers by email — no native user
      .mockResolvedValueOnce({ Users: [{ Username: 'Google_g1', UserStatus: 'EXTERNAL_PROVIDER', Attributes: [] }] }) // ListUsers by sub — no identities attr

    await handler(baseEvent({ identities: '' }), {} as never, () => undefined)

    expect(dynamoSend).toHaveBeenCalledTimes(4)
    const linkPut = dynamoSend.mock.calls[2]?.[0] as { input: { TableName: string; Item: Record<string, unknown> } }
    expect(linkPut.input.TableName).toBe('heediq-cognito-identities')
    expect(linkPut.input.Item).toMatchObject({ sub: 'ext-sub', accountId: 'ext-sub' })

    const auditPut = dynamoSend.mock.calls[3]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(auditPut.input.Item['action']).toBe('POST_AUTH_PROVIDER_CONTEXT_MISSING')
  })

  it('tolerates InvalidParameterException on link as already-linked', async () => {
    dynamoSend
      .mockResolvedValueOnce({ Item: undefined }) // Get identities table -> no mapping
      .mockResolvedValueOnce({ Items: [{ userId: 'native-sub' }] }) // Query by-email -> canonical account
      .mockResolvedValueOnce({}) // Put method
    cognitoSend
      .mockResolvedValueOnce({ Users: [{ Username: 'a@b.com', UserStatus: 'CONFIRMED', Attributes: [{ Name: 'sub', Value: 'native-sub' }] }] })
      .mockResolvedValueOnce({ Users: [{ Username: 'Google_g1', UserStatus: 'EXTERNAL_PROVIDER', Attributes: [] }] })
      .mockRejectedValueOnce(Object.assign(new Error('already linked'), { name: 'InvalidParameterException' }))

    await expect(handler(baseEvent({ identities: '[{"providerName":"Google","userId":"g1"}]' }), {} as never, () => undefined)).resolves.toBeDefined()
    expect(dynamoSend).toHaveBeenCalledTimes(3) // no audit put after the swallowed link failure
  })
})
