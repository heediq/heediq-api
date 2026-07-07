import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PostConfirmationConfirmSignUpTriggerEvent } from 'aws-lambda'

process.env['USERS_TABLE_NAME'] = 'heediq-users'
process.env['USER_AUTH_METHODS_TABLE_NAME'] = 'heediq-user-auth-methods'
process.env['AUTH_AUDIT_LOG_TABLE_NAME'] = 'heediq-auth-audit-log'
process.env['COGNITO_IDENTITIES_TABLE_NAME'] = 'heediq-cognito-identities'

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

  it('resolves via the identities table and records a native COGNITO method + audit event', async () => {
    send
      .mockResolvedValueOnce({ Item: { sub: 'native-sub', accountId: 'account-1' } }) // Get identities table
      .mockResolvedValueOnce({}) // Put method
      .mockResolvedValueOnce({}) // Put audit

    await handler(baseEvent(), {} as never, () => undefined)

    expect(send).toHaveBeenCalledTimes(3)
    const methodPut = send.mock.calls[1]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(methodPut.input.Item['pk']).toBe('USER#account-1')
    expect(methodPut.input.Item['sk']).toBe('METHOD#COGNITO')
    expect(methodPut.input.Item['provider']).toBe('COGNITO')

    const auditPut = send.mock.calls[2]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(auditPut.input.Item['pk']).toBe('USER#account-1')
    expect(auditPut.input.Item['action']).toBe('POST_CONFIRMATION_SIGNUP')
  })

  it('falls back to the email lookup when the identities table has no mapping', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined }) // Get identities table: no mapping
      .mockResolvedValueOnce({ Items: [{ userId: 'canonical-1' }] }) // Query by-email: existing row
      .mockResolvedValueOnce({}) // Put method
      .mockResolvedValueOnce({}) // Put audit

    await handler(baseEvent({ identities: '[{"providerName":"Google","userId":"g-1"}]' }), {} as never, () => undefined)

    expect(send).toHaveBeenCalledTimes(4)
    const methodPut = send.mock.calls[2]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(methodPut.input.Item['pk']).toBe('USER#canonical-1')
    expect(methodPut.input.Item['sk']).toBe('METHOD#GOOGLE')
    expect(methodPut.input.Item['providerSub']).toBe('g-1')
  })

  it('writes nothing for a genuinely new signup that resolves to no existing account', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined }) // Get identities table: no mapping
      .mockResolvedValueOnce({ Items: [] }) // Query by-email: no match

    const result = await handler(baseEvent(), {} as never, () => undefined)

    expect(send).toHaveBeenCalledTimes(2) // only the two resolution lookups — no writes
    expect(result).toBeDefined()
  })

  it('swallows ConditionalCheckFailedException when the method row already exists', async () => {
    const conflict = Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' })
    send
      .mockResolvedValueOnce({ Item: { sub: 'native-sub', accountId: 'account-1' } })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({})

    await expect(handler(baseEvent(), {} as never, () => undefined)).resolves.toBeDefined()
  })
})
