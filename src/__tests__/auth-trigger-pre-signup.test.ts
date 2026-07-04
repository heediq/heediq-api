import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PreSignUpExternalProviderTriggerEvent } from 'aws-lambda'

process.env['USERS_TABLE_NAME'] = 'heediq-users'
process.env['USER_AUTH_METHODS_TABLE_NAME'] = 'heediq-user-auth-methods'

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

const { handler } = await import('../handlers/auth-trigger-pre-signup.js')

function baseEvent(userName: string, overrides: Record<string, string> = {}): PreSignUpExternalProviderTriggerEvent {
  return {
    triggerSource: 'PreSignUp_ExternalProvider',
    userPoolId: 'eu-west-1_test',
    userName,
    request: {
      userAttributes: { sub: 'ext-sub', email: 'a@b.com', ...overrides },
    },
    response: {},
  } as unknown as PreSignUpExternalProviderTriggerEvent
}

describe('auth-trigger-pre-signup handler', () => {
  beforeEach(() => { dynamoSend.mockReset(); cognitoSend.mockReset() })

  it('ignores non-external-provider trigger sources', async () => {
    const event = { ...baseEvent('Google_g1'), triggerSource: 'PreSignUp_SignUp' } as PreSignUpExternalProviderTriggerEvent
    await handler(event, {} as never, () => undefined)
    expect(cognitoSend).not.toHaveBeenCalled()
  })

  it('lets Cognito create a brand-new external user when no existing account matches the email', async () => {
    dynamoSend.mockResolvedValueOnce({ Items: [] }) // no existing users row
    cognitoSend.mockResolvedValueOnce({ Users: [] }) // ListUsers — no native user either

    const result = await handler(baseEvent('Google_g1'), {} as never, () => undefined)
    expect(result).toBeDefined()
    expect(cognitoSend).toHaveBeenCalledTimes(1) // ListUsers only, no link attempted
  })

  it('links the federated identity onto the existing native user for the same email', async () => {
    dynamoSend
      .mockResolvedValueOnce({ Items: [{ userId: 'native-sub' }] }) // existing users row
      .mockResolvedValueOnce({}) // Put method
    cognitoSend
      .mockResolvedValueOnce({ Users: [{ Username: 'a@b.com', UserStatus: 'CONFIRMED' }] }) // ListUsers
      .mockResolvedValueOnce({}) // AdminLinkProviderForUser

    await handler(baseEvent('Google_g1'), {} as never, () => undefined)

    expect(cognitoSend).toHaveBeenCalledTimes(2)
    const linkCall = cognitoSend.mock.calls[1]?.[0] as { input: { SourceUser: { ProviderName: string; ProviderAttributeValue: string } } }
    expect(linkCall.input.SourceUser).toEqual({ ProviderName: 'Google', ProviderAttributeName: 'Cognito_Subject', ProviderAttributeValue: 'g1' })
  })

  it('throws a user-facing error when email is missing', async () => {
    const event = baseEvent('Google_g1', { email: '' })
    delete (event.request.userAttributes as Record<string, string>)['email']
    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(/email/i)
  })

  it('throws when the provider identity cannot be resolved from the username', async () => {
    await expect(handler(baseEvent('opaque-username-no-underscore'), {} as never, () => undefined)).rejects.toThrow(/social provider/i)
  })
})
