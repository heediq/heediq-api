import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PostConfirmationConfirmSignUpTriggerEvent } from 'aws-lambda'

process.env['USERS_TABLE_NAME'] = 'heediq-users'
process.env['USER_AUTH_METHODS_TABLE_NAME'] = 'heediq-user-auth-methods'
process.env['AUTH_AUDIT_LOG_TABLE_NAME'] = 'heediq-auth-audit-log'

const send = vi.fn()
vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: (...args: unknown[]) => send(...args) } }))

const { handler } = await import('../handlers/auth-trigger-post-confirmation.js')

function baseEvent(overrides: Record<string, string> = {}): PostConfirmationConfirmSignUpTriggerEvent {
  return {
    triggerSource: 'PostConfirmation_ConfirmSignUp',
    userName: 'a@b.com',
    request: {
      userAttributes: { sub: 'native-sub', email: 'a@b.com', ...overrides },
    },
    response: {},
  } as unknown as PostConfirmationConfirmSignUpTriggerEvent
}

describe('auth-trigger-post-confirmation handler', () => {
  beforeEach(() => { send.mockReset() })

  it('ignores non-matching trigger sources', async () => {
    const event = { ...baseEvent(), triggerSource: 'PostConfirmation_ConfirmForgotPassword' } as PostConfirmationConfirmSignUpTriggerEvent
    await handler(event, {} as never, () => undefined)
    expect(send).not.toHaveBeenCalled()
  })

  it('records a native COGNITO method and audit event when no identities claim is present', async () => {
    send
      .mockResolvedValueOnce({ Items: [] }) // by-email lookup — no existing users row yet
      .mockResolvedValueOnce({}) // Put method
      .mockResolvedValueOnce({}) // Put audit

    await handler(baseEvent(), {} as never, () => undefined)

    expect(send).toHaveBeenCalledTimes(3)
    const methodPut = send.mock.calls[1]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(methodPut.input.Item['pk']).toBe('USER#native-sub')
    expect(methodPut.input.Item['sk']).toBe('METHOD#COGNITO')
    expect(methodPut.input.Item['provider']).toBe('COGNITO')
  })

  it('records the federated provider method when an identities claim is present', async () => {
    send
      .mockResolvedValueOnce({ Items: [{ userId: 'canonical-1' }] }) // existing users row for this email
      .mockResolvedValueOnce({}) // Put method
      .mockResolvedValueOnce({}) // Put audit

    await handler(baseEvent({ identities: '[{"providerName":"Google","userId":"g-1"}]' }), {} as never, () => undefined)

    const methodPut = send.mock.calls[1]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(methodPut.input.Item['pk']).toBe('USER#canonical-1')
    expect(methodPut.input.Item['sk']).toBe('METHOD#GOOGLE')
    expect(methodPut.input.Item['providerSub']).toBe('g-1')
  })

  it('swallows ConditionalCheckFailedException when the method row already exists', async () => {
    const conflict = Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' })
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({})

    await expect(handler(baseEvent(), {} as never, () => undefined)).resolves.toBeDefined()
  })
})
