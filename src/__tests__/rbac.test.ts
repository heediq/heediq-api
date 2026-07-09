import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDynamoSend = vi.hoisted(() => vi.fn())
vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

import { ensureOrgRbacSeeded, ensureUserRoleAssignment, resolveEffectivePermissions, type RbacTables } from '../lib/rbac.js'

const tables: RbacTables = {
  rolesTable: 'heediq-roles',
  groupsTable: 'heediq-groups',
  roleAssignmentsTable: 'heediq-role-assignments',
}
const orgId = '00000000-0000-0000-0000-000000000001'
const userId = '00000000-0000-0000-0000-000000000002'

describe('ensureOrgRbacSeeded', () => {
  beforeEach(() => vi.clearAllMocks())

  it('seeds both system roles with the default permission catalog', async () => {
    mockDynamoSend.mockResolvedValue({})
    const seeded = await ensureOrgRbacSeeded(tables, orgId)

    expect(seeded.admin.isSystemRole).toBe(true)
    expect(seeded.admin.permissions).toContain('org:manage-roles')
    expect(seeded.member.permissions).not.toContain('org:manage-roles')
    expect(mockDynamoSend).toHaveBeenCalledTimes(2)
  })

  it('writes each role keyed by pk=ORG#<orgId>, sk=ROLE#<roleId>', async () => {
    mockDynamoSend.mockResolvedValue({})
    const seeded = await ensureOrgRbacSeeded(tables, orgId)

    const puts = mockDynamoSend.mock.calls.map((c) => (c[0] as { input: { TableName: string; Item: Record<string, unknown> } }).input)
    expect(puts.every((p) => p.TableName === 'heediq-roles')).toBe(true)
    expect(puts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Item: expect.objectContaining({ pk: `ORG#${orgId}`, sk: `ROLE#${seeded.admin.roleId}` }) }),
        expect.objectContaining({ Item: expect.objectContaining({ pk: `ORG#${orgId}`, sk: `ROLE#${seeded.member.roleId}` }) }),
      ]),
    )
  })
})

describe('ensureUserRoleAssignment', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writes a role-type assignment keyed by pk=ORG#<orgId>#USER#<userId>, sk=ROLE#<roleId>', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const roleId = '00000000-0000-0000-0000-000000000003'

    await ensureUserRoleAssignment(tables, orgId, userId, roleId)

    expect(mockDynamoSend).toHaveBeenCalledTimes(1)
    const put = mockDynamoSend.mock.calls[0]?.[0] as { input: { TableName: string; Item: Record<string, unknown> } }
    expect(put.input.TableName).toBe('heediq-role-assignments')
    expect(put.input.Item).toMatchObject({
      pk: `ORG#${orgId}#USER#${userId}`,
      sk: `ROLE#${roleId}`,
      assignmentType: 'role',
      userId,
      roleId,
    })
  })
})

describe('resolveEffectivePermissions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns an empty array when the user has no assignments', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })

    const permissions = await resolveEffectivePermissions(tables, orgId, userId)

    expect(permissions).toEqual([])
    expect(mockDynamoSend).toHaveBeenCalledTimes(1)
  })

  it('unions permissions from a direct role assignment', async () => {
    const roleId = '00000000-0000-0000-0000-000000000003'
    mockDynamoSend
      .mockResolvedValueOnce({ Items: [{ assignmentType: 'role', userId, roleId, createdAt: new Date().toISOString() }] }) // assignments
      .mockResolvedValueOnce({ Item: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId}`, orgId, roleId, name: 'Reviewer', permissions: ['sources:read', 'audit:read'], isSystemRole: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }) // role Get

    const permissions = await resolveEffectivePermissions(tables, orgId, userId)

    expect(permissions.sort()).toEqual(['audit:read', 'sources:read'])
  })

  it('unions permissions from every role reached via a group assignment', async () => {
    const groupId = '00000000-0000-0000-0000-000000000004'
    const roleId = '00000000-0000-0000-0000-000000000005'
    mockDynamoSend
      .mockResolvedValueOnce({ Items: [{ assignmentType: 'group', userId, groupId, createdAt: new Date().toISOString() }] }) // assignments
      .mockResolvedValueOnce({ Item: { pk: `ORG#${orgId}`, sk: `GROUP#${groupId}`, orgId, groupId, name: 'Engineering', roleIds: [roleId], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }) // group Get
      .mockResolvedValueOnce({ Item: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId}`, orgId, roleId, name: 'Reviewer', permissions: ['sources:create'], isSystemRole: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }) // role Get

    const permissions = await resolveEffectivePermissions(tables, orgId, userId)

    expect(permissions).toEqual(['sources:create'])
  })

  it('deduplicates a permission granted by more than one role', async () => {
    const roleId1 = '00000000-0000-0000-0000-000000000006'
    const roleId2 = '00000000-0000-0000-0000-000000000007'
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          { assignmentType: 'role', userId, roleId: roleId1, createdAt: new Date().toISOString() },
          { assignmentType: 'role', userId, roleId: roleId2, createdAt: new Date().toISOString() },
        ],
      }) // assignments
      .mockResolvedValueOnce({ Item: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId1}`, orgId, roleId: roleId1, name: 'A', permissions: ['sources:read'], isSystemRole: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } })
      .mockResolvedValueOnce({ Item: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId2}`, orgId, roleId: roleId2, name: 'B', permissions: ['sources:read'], isSystemRole: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } })

    const permissions = await resolveEffectivePermissions(tables, orgId, userId)

    expect(permissions).toEqual(['sources:read'])
  })

  it('ignores an assignment referencing a role that no longer exists', async () => {
    const roleId = '00000000-0000-0000-0000-000000000008'
    mockDynamoSend
      .mockResolvedValueOnce({ Items: [{ assignmentType: 'role', userId, roleId, createdAt: new Date().toISOString() }] }) // assignments
      .mockResolvedValueOnce({}) // role Get — no Item

    const permissions = await resolveEffectivePermissions(tables, orgId, userId)

    expect(permissions).toEqual([])
  })
})
