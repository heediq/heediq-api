import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PreTokenGenerationTriggerEvent } from 'aws-lambda'

process.env['ORGS_TABLE_NAME'] = 'heediq-orgs'
process.env['USERS_TABLE_NAME'] = 'heediq-users'

const send = vi.fn()
vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: (...args: unknown[]) => send(...args) } }))

const { handler } = await import('../handlers/auth-provision.js')

function baseEvent(): PreTokenGenerationTriggerEvent {
  return {
    request: { userAttributes: { sub: 'user-1', email: 'ada@acme.com' } },
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
})
