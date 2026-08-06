import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PreTokenGenerationTriggerEvent } from 'aws-lambda'

process.env['ORGS_TABLE_NAME'] = 'heediq-orgs'
process.env['USERS_TABLE_NAME'] = 'heediq-users'
process.env['COGNITO_IDENTITIES_TABLE_NAME'] = 'heediq-cognito-identities'
process.env['USER_AUTH_METHODS_TABLE_NAME'] = 'heediq-user-auth-methods'
process.env['AUTH_AUDIT_LOG_TABLE_NAME'] = 'heediq-auth-audit-log'
process.env['ROLES_TABLE_NAME'] = 'heediq-roles'
process.env['GROUPS_TABLE_NAME'] = 'heediq-groups'
process.env['ROLE_ASSIGNMENTS_TABLE_NAME'] = 'heediq-role-assignments'

const send = vi.fn()
vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: (...args: unknown[]) => send(...args) } }))

const emitServerAnalytics = vi.hoisted(() => vi.fn())
vi.mock('../lib/analytics.js', () => ({ emitServerAnalytics }))

const { handler } = await import('../handlers/auth-provision.js')

function baseEvent(overrides: Record<string, string> = {}): PreTokenGenerationTriggerEvent {
  return {
    request: {
      userAttributes: { sub: 'user-1', email: 'ada@acme.com', email_verified: 'true', ...overrides },
    },
    response: {},
  } as unknown as PreTokenGenerationTriggerEvent
}

// Mocks the 6 sends made by the new-org provisioning branch's ensureOrgRbacSeeded (2: admin +
// member role seed) and main Promise.all (4: org, user, linkIdentity, authMethod, audit,
// roleAssignment — 6 total), on top of whatever calls the caller has already queued for the
// identities/email lookups.
function mockNewOrgProvisioning() {
  send
    .mockResolvedValueOnce({}) // Put admin role (ensureOrgRbacSeeded)
    .mockResolvedValueOnce({}) // Put member role (ensureOrgRbacSeeded)
    .mockResolvedValueOnce({}) // Put org
    .mockResolvedValueOnce({}) // Put user
    .mockResolvedValueOnce({}) // Put linkIdentity
    .mockResolvedValueOnce({}) // Put auth method
    .mockResolvedValueOnce({}) // Put audit
    .mockResolvedValueOnce({}) // Put role assignment (ensureUserRoleAssignment)
}

describe('auth-provision handler', () => {
  beforeEach(() => { send.mockReset(); emitServerAnalytics.mockReset() })

  it('resolves via the identities table and returns claims with a single lookup', async () => {
    send
      .mockResolvedValueOnce({ Item: { sub: 'user-1', accountId: 'account-1' } }) // Get identities table
      .mockResolvedValueOnce({ Item: { userId: 'account-1', orgId: 'org-1', role: 'member' } }) // Get user
      .mockResolvedValueOnce({ Items: [] }) // Query role-assignments (resolveEffectivePermissions)

    const result = await handler(baseEvent(), {} as never, () => undefined) as PreTokenGenerationTriggerEvent

    expect(send).toHaveBeenCalledTimes(3)
    expect(result.response.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({
      'custom:accountId': 'account-1',
      'custom:orgId': 'org-1',
      'custom:role': 'member',
      'custom:permissions': '[]',
    })
  })

  it('self-heals via email lookup when the identities table has no mapping and pins the mapping via linkIdentity', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined }) // Get identities table: no mapping
      .mockResolvedValueOnce({ Items: [{ userId: 'account-1', email: 'ada@acme.com' }] }) // Query by-email
      .mockResolvedValueOnce({ Item: { userId: 'account-1', orgId: 'org-1', role: 'admin' } }) // Get user
      .mockResolvedValueOnce({}) // Put linkIdentity
      .mockResolvedValueOnce({ Items: [] }) // Query role-assignments (resolveEffectivePermissions)

    const result = await handler(
      baseEvent({ sub: 'native-user-uuid' }),
      {} as never,
      () => undefined,
    ) as PreTokenGenerationTriggerEvent

    expect(send).toHaveBeenCalledTimes(5)
    const linkPut = send.mock.calls[3]?.[0] as { input: { TableName: string; Item: Record<string, unknown> } }
    expect(linkPut.input.TableName).toBe('heediq-cognito-identities')
    expect(linkPut.input.Item).toMatchObject({ sub: 'native-user-uuid', accountId: 'account-1' })
    expect(result.response.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({
      'custom:accountId': 'account-1',
      'custom:orgId': 'org-1',
      'custom:role': 'admin',
      'custom:permissions': '[]',
    })
  })

  it('provisions a new org, admin user, and identity mapping on first login', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined }) // Get identities table: no mapping
      .mockResolvedValueOnce({ Items: [] }) // Query by-email: no match
    mockNewOrgProvisioning()

    const result = await handler(baseEvent(), {} as never, () => undefined) as PreTokenGenerationTriggerEvent

    expect(send).toHaveBeenCalledTimes(10)
    const claims = result.response.claimsOverrideDetails?.claimsToAddOrOverride as Record<string, string>
    expect(claims['custom:role']).toBe('admin')
    expect(typeof claims['custom:orgId']).toBe('string')
    expect(typeof claims['custom:accountId']).toBe('string')
    expect(JSON.parse(claims['custom:permissions'] as string)).toEqual(
      expect.arrayContaining(['org:manage-roles', 'sources:read', 'audit:read']),
    )

    const linkPut = send.mock.calls[6]?.[0] as { input: { TableName: string; Item: Record<string, unknown> } }
    expect(linkPut.input.TableName).toBe('heediq-cognito-identities')
    expect(linkPut.input.Item['accountId']).toBe(claims['custom:accountId'])
  })

  it('provisions an org/user even when email_verified is false (D-090 — supersedes D-080)', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Items: [] })
    mockNewOrgProvisioning()

    const result = await handler(
      baseEvent({ email_verified: 'false' }),
      {} as never,
      () => undefined,
    ) as PreTokenGenerationTriggerEvent

    expect(send).toHaveBeenCalledTimes(10)
    expect(result.response.claimsOverrideDetails?.claimsToAddOrOverride).toBeDefined()
  })

  it('normalizes email to lowercase/trimmed before writing the user row', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Items: [] })
    mockNewOrgProvisioning()

    await handler(
      baseEvent({ email: '  Ada@ACME.com  ' }),
      {} as never,
      () => undefined,
    )

    const userPut = send.mock.calls[5]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(userPut.input.Item['email']).toBe('ada@acme.com')
  })

  it('sets passwordSet=false for a federated-only first login', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Items: [] })
    mockNewOrgProvisioning()

    await handler(
      baseEvent({ identities: '[{"providerName":"Google","userId":"g-1"}]' }),
      {} as never,
      () => undefined,
    )

    const userPut = send.mock.calls[5]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(userPut.input.Item['passwordSet']).toBe(false)
  })

  it('sets passwordSet=true for a native email/password first login', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Items: [] })
    mockNewOrgProvisioning()

    await handler(baseEvent(), {} as never, () => undefined)

    const userPut = send.mock.calls[5]?.[0] as { input: { Item: Record<string, unknown> } }
    expect(userPut.input.Item['passwordSet']).toBe(true)
  })

  it('emits a user_provisioned {tier:free} server event keyed to the new account+org (D-154)', async () => {
    send
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Items: [] })
    mockNewOrgProvisioning()

    const result = await handler(baseEvent(), {} as never, () => undefined) as PreTokenGenerationTriggerEvent
    const claims = result.response.claimsOverrideDetails?.claimsToAddOrOverride as Record<string, string>

    expect(emitServerAnalytics).toHaveBeenCalledTimes(1)
    expect(emitServerAnalytics).toHaveBeenCalledWith({
      identity: { userId: claims['custom:accountId'], orgId: claims['custom:orgId'] },
      type: 'user_provisioned',
      payload: { tier: 'free' },
    })
  })

  it('does not emit user_provisioned when an existing user is resolved (no new org)', async () => {
    send
      .mockResolvedValueOnce({ Item: { sub: 'user-1', accountId: 'account-1' } })
      .mockResolvedValueOnce({ Item: { userId: 'account-1', orgId: 'org-1', role: 'member' } })
      .mockResolvedValueOnce({ Items: [] })

    await handler(baseEvent(), {} as never, () => undefined)

    expect(emitServerAnalytics).not.toHaveBeenCalled()
  })
})
