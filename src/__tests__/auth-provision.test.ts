import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PreTokenGenerationTriggerEvent } from 'aws-lambda'

process.env['ORGS_TABLE_NAME'] = 'heediq-orgs'
process.env['USERS_TABLE_NAME'] = 'heediq-users'

const send = vi.fn()
vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: (...args: unknown[]) => send(...args) } }))

const { handler } = await import('../handlers/auth-provision.js')

function baseEvent(overrides: Record<string, string> = {}): PreTokenGenerationTriggerEvent {
  return {
    request: {
      userAttributes: { sub: 'user-1', email: 'ada@acme.com', email_verified: 'true', ...overrides },
    },
    response: {},
  } as unknown as PreTokenGenerationTriggerEvent
}

describe('auth-provision handler', () => {
  beforeEach(() => { send.mockReset() })

  it('injects existing claims without writing when the user already has an org', async () => {
    send.mockResolvedValueOnce({ Item: { userId: 'user-1', orgId: 'org-1', role: 'member' } })

    const result = await handler(baseEvent(), {} as never, () => undefined) as PreTokenGenerationTriggerEvent

    expect(send).toHaveBeenCalledTimes(1) // only the Get, no Puts
    expect(result.response.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({
      'custom:orgId': 'org-1',
      'custom:role': 'member',
    })
  })

  it('provisions a new org and admin user on first login', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined }) // Get: no existing user
      .mockResolvedValueOnce({}) // Put org
      .mockResolvedValueOnce({}) // Put user

    const result = await handler(baseEvent(), {} as never, () => undefined) as PreTokenGenerationTriggerEvent

    expect(send).toHaveBeenCalledTimes(3)
    const claims = result.response.claimsOverrideDetails?.claimsToAddOrOverride as Record<string, string>
    expect(claims['custom:role']).toBe('admin')
    expect(typeof claims['custom:orgId']).toBe('string')
  })

  it('does not provision an org/user when email_verified is false (D-080)', async () => {
    send.mockResolvedValueOnce({ Item: undefined }) // Get: no existing user

    const result = await handler(
      baseEvent({ email_verified: 'false' }),
      {} as never,
      () => undefined,
    ) as PreTokenGenerationTriggerEvent

    expect(send).toHaveBeenCalledTimes(1) // only the Get — no Puts
    expect(result.response.claimsOverrideDetails).toBeUndefined()
  })

  it('normalizes email to lowercase/trimmed before writing the user row', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    await handler(
      baseEvent({ email: '  Ada@ACME.com  ' }),
      {} as never,
      () => undefined,
    )

    const userPut = send.mock.calls[2]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(userPut.input.Item['email']).toBe('ada@acme.com')
  })

  it('sets passwordSet=false for a federated-only first login', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    await handler(
      baseEvent({ identities: '[{"providerName":"Google"}]' }),
      {} as never,
      () => undefined,
    )

    const userPut = send.mock.calls[2]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(userPut.input.Item['passwordSet']).toBe(false)
  })

  it('sets passwordSet=true for a native email/password first login', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    await handler(baseEvent(), {} as never, () => undefined)

    const userPut = send.mock.calls[2]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(userPut.input.Item['passwordSet']).toBe(true)
  })
})
