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

  it('injects existing claims without writing when the user already has an org (found by email)', async () => {
    send.mockResolvedValueOnce({ Items: [{ userId: 'user-1', orgId: 'org-1', role: 'member' }] }) // Query by-email

    const result = await handler(baseEvent(), {} as never, () => undefined) as PreTokenGenerationTriggerEvent

    expect(send).toHaveBeenCalledTimes(1) // only the Query, no Get, no Puts
    expect(result.response.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({
      'custom:orgId': 'org-1',
      'custom:role': 'member',
    })
  })

  it('resolves the existing row by a different sub than the current login (D-090 — post-linking re-login)', async () => {
    // Simulates a Google login AFTER AdminLinkProviderForUser has linked it to a native user:
    // the token's sub ("native-user-uuid") differs from the sub that originally created the row
    // ("user-1"), but the email-first lookup must still resolve to the same org — no duplicate.
    send.mockResolvedValueOnce({ Items: [{ userId: 'user-1', orgId: 'org-1', role: 'admin' }] })

    const result = await handler(
      baseEvent({ sub: 'native-user-uuid' }),
      {} as never,
      () => undefined,
    ) as PreTokenGenerationTriggerEvent

    expect(send).toHaveBeenCalledTimes(1) // resolved by email — no Get fallback, no re-provisioning
    expect(result.response.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({
      'custom:orgId': 'org-1',
      'custom:role': 'admin',
    })
  })

  it('falls back to a sub-keyed Get when no row matches the email (defensive path)', async () => {
    send
      .mockResolvedValueOnce({ Items: [] }) // Query by-email: no match
      .mockResolvedValueOnce({ Item: { userId: 'user-1', orgId: 'org-1', role: 'member' } }) // Get by sub: match

    const result = await handler(baseEvent(), {} as never, () => undefined) as PreTokenGenerationTriggerEvent

    expect(send).toHaveBeenCalledTimes(2)
    expect(result.response.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({
      'custom:orgId': 'org-1',
      'custom:role': 'member',
    })
  })

  it('provisions a new org and admin user on first login', async () => {
    send
      .mockResolvedValueOnce({ Items: [] }) // Query by-email: no match
      .mockResolvedValueOnce({ Item: undefined }) // Get by sub: no match
      .mockResolvedValueOnce({}) // Put org
      .mockResolvedValueOnce({}) // Put user

    const result = await handler(baseEvent(), {} as never, () => undefined) as PreTokenGenerationTriggerEvent

    expect(send).toHaveBeenCalledTimes(4)
    const claims = result.response.claimsOverrideDetails?.claimsToAddOrOverride as Record<string, string>
    expect(claims['custom:role']).toBe('admin')
    expect(typeof claims['custom:orgId']).toBe('string')
  })

  it('provisions an org/user even when email_verified is false (D-090 — supersedes D-080)', async () => {
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    const result = await handler(
      baseEvent({ email_verified: 'false' }),
      {} as never,
      () => undefined,
    ) as PreTokenGenerationTriggerEvent

    expect(send).toHaveBeenCalledTimes(4)
    expect(result.response.claimsOverrideDetails?.claimsToAddOrOverride).toBeDefined()
  })

  it('normalizes email to lowercase/trimmed before writing the user row', async () => {
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    await handler(
      baseEvent({ email: '  Ada@ACME.com  ' }),
      {} as never,
      () => undefined,
    )

    const userPut = send.mock.calls[3]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(userPut.input.Item['email']).toBe('ada@acme.com')
  })

  it('sets passwordSet=false for a federated-only first login', async () => {
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    await handler(
      baseEvent({ identities: '[{"providerName":"Google"}]' }),
      {} as never,
      () => undefined,
    )

    const userPut = send.mock.calls[3]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(userPut.input.Item['passwordSet']).toBe(false)
  })

  it('sets passwordSet=true for a native email/password first login', async () => {
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    await handler(baseEvent(), {} as never, () => undefined)

    const userPut = send.mock.calls[3]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(userPut.input.Item['passwordSet']).toBe(true)
  })
})
