import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolveEffectivePermissions, type RbacTables } from '../../src/lib/rbac.js'
import { seedOrg, seedUser, seedRoles, seedCustomRole, seedGroup, seedRoleAssignment, type IntegrationTables } from './seed.js'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'

const tables: IntegrationTables = {
  orgsTable: 'heediq-orgs',
  usersTable: 'heediq-users',
  cognitoIdentitiesTable: 'heediq-cognito-identities',
  rolesTable: 'heediq-roles',
  groupsTable: 'heediq-groups',
  roleAssignmentsTable: 'heediq-role-assignments',
}
const rbacTables: RbacTables = {
  rolesTable: tables.rolesTable,
  groupsTable: tables.groupsTable,
  roleAssignmentsTable: tables.roleAssignmentsTable,
}

describe('resolveEffectivePermissions (integration, DynamoDB Local)', () => {
  it('returns permissions from a direct role assignment', async () => {
    const org = seedOrg(tables)
    await org.write()
    const user = seedUser(tables, { orgId: org.orgId })
    await user.write()
    const roles = await seedRoles(tables, org.orgId)
    await seedRoleAssignment(tables, org.orgId, user.userId, { assignmentType: 'role', roleId: roles.member.roleId })

    const permissions = await resolveEffectivePermissions(rbacTables, org.orgId, user.userId)
    expect(permissions.sort()).toEqual([...DEFAULT_ORG_RBAC_SEED.member.permissions].sort())
  })

  it('unions permissions reached via group membership (previously untested path)', async () => {
    const org = seedOrg(tables)
    await org.write()
    const user = seedUser(tables, { orgId: org.orgId })
    await user.write()

    const customRoleId = await seedCustomRole(tables, org.orgId, ['audit:read'])
    const groupId = await seedGroup(tables, org.orgId, [customRoleId])
    await seedRoleAssignment(tables, org.orgId, user.userId, { assignmentType: 'group', groupId })

    const permissions = await resolveEffectivePermissions(rbacTables, org.orgId, user.userId)
    expect(permissions).toEqual(['audit:read'])
  })

  it('unions direct-role and group-mediated permissions with no duplicates', async () => {
    const org = seedOrg(tables)
    await org.write()
    const user = seedUser(tables, { orgId: org.orgId })
    await user.write()

    const roles = await seedRoles(tables, org.orgId)
    const customRoleId = await seedCustomRole(tables, org.orgId, ['audit:read', ...roles.member.permissions.slice(0, 1)])
    const groupId = await seedGroup(tables, org.orgId, [customRoleId])

    await Promise.all([
      seedRoleAssignment(tables, org.orgId, user.userId, { assignmentType: 'role', roleId: roles.member.roleId }),
      seedRoleAssignment(tables, org.orgId, user.userId, { assignmentType: 'group', groupId }),
    ])

    const permissions = await resolveEffectivePermissions(rbacTables, org.orgId, user.userId)
    const expected = new Set([...roles.member.permissions, 'audit:read'])
    expect(new Set(permissions)).toEqual(expected)
  })

  it('returns an empty list for a user with no role assignments', async () => {
    const org = seedOrg(tables)
    await org.write()
    const permissions = await resolveEffectivePermissions(rbacTables, org.orgId, randomUUID())
    expect(permissions).toEqual([])
  })
})
