import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PostAuthenticationTriggerEvent } from 'aws-lambda'

process.env['USERS_TABLE_NAME'] = 'heediq-users'
process.env['USER_AUTH_METHODS_TABLE_NAME'] = 'heediq-user-auth-methods'
process.env['AUTH_AUDIT_LOG_TABLE_NAME'] = 'heediq-auth-audit-log'

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

  it('records the method and auto-links a federated login not yet linked to the native user', async () => {
    dynamoSend
      .mockResolvedValueOnce({ Items: [{ userId: 'native-sub' }] }) // by-email lookup -> canonical account
      .mockResolvedValueOnce({}) // Put method
      .mockResolvedValueOnce({}) // Put audit (AUTO_LINK_POST_AUTH)
    cognitoSend
      .mockResolvedValueOnce({ Users: [{ Username: 'a@b.com', UserStatus: 'CONFIRMED', Attributes: [{ Name: 'sub', Value: 'native-sub' }] }] }) // ListUsers by email
      .mockResolvedValueOnce({ Users: [{ Username: 'Google_g1', UserStatus: 'EXTERNAL_PROVIDER', Attributes: [{ Name: 'identities', Value: '[{"providerName":"Google","userId":"g1"}]' }] }] }) // ListUsers by sub
      .mockResolvedValueOnce({}) // AdminLinkProviderForUser

    await handler(baseEvent({ identities: '[{"providerName":"Google","userId":"g1"}]' }), {} as never, () => undefined)

    expect(cognitoSend).toHaveBeenCalledTimes(3)
    const linkCall = cognitoSend.mock.calls[2]?.[0] as { input: { SourceUser: { ProviderAttributeValue: string } } }
    expect(linkCall.input.SourceUser.ProviderAttributeValue).toBe('g1')
  })

  it('records a provider-context-missing audit event when identities cannot be resolved', async () => {
    dynamoSend
      .mockResolvedValueOnce({ Items: [] }) // by-email -> no existing row, fall back to own sub
      .mockResolvedValueOnce({}) // Put audit (PROVIDER_CONTEXT_MISSING)
    cognitoSend
      .mockResolvedValueOnce({ Users: [] }) // ListUsers by email — no native user
      .mockResolvedValueOnce({ Users: [{ Username: 'Google_g1', UserStatus: 'EXTERNAL_PROVIDER', Attributes: [] }] }) // ListUsers by sub — no identities attr

    await handler(baseEvent({ identities: '' }), {} as never, () => undefined)

    const auditPut = dynamoSend.mock.calls[1]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(auditPut.input.Item['action']).toBe('POST_AUTH_PROVIDER_CONTEXT_MISSING')
  })

  it('tolerates InvalidParameterException on link as already-linked', async () => {
    dynamoSend
      .mockResolvedValueOnce({ Items: [{ userId: 'native-sub' }] })
      .mockResolvedValueOnce({})
    cognitoSend
      .mockResolvedValueOnce({ Users: [{ Username: 'a@b.com', UserStatus: 'CONFIRMED', Attributes: [{ Name: 'sub', Value: 'native-sub' }] }] })
      .mockResolvedValueOnce({ Users: [{ Username: 'Google_g1', UserStatus: 'EXTERNAL_PROVIDER', Attributes: [] }] })
      .mockRejectedValueOnce(Object.assign(new Error('already linked'), { name: 'InvalidParameterException' }))

    await expect(handler(baseEvent({ identities: '[{"providerName":"Google","userId":"g1"}]' }), {} as never, () => undefined)).resolves.toBeDefined()
  })
})
