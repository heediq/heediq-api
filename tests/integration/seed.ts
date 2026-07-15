// Composable seed builders for integration tests against DynamoDB Local. Reused later for k6
// stress-test data generation (write the seeding logic once, import it from both places).
import { randomUUID } from 'node:crypto'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../../src/lib/dynamo.js'
import { DEFAULT_ORG_RBAC_SEED, SYSTEM_ROLES, type OrgRole, type Permission, type SystemRoleName } from '@heediq/shared'

export type IntegrationTables = {
  orgsTable: string
  usersTable: string
  cognitoIdentitiesTable: string
  rolesTable: string
  groupsTable: string
  roleAssignmentsTable: string
}

export function seedOrg(tables: IntegrationTables, overrides: Partial<{ orgId: string; name: string; emailDomain: string }> = {}) {
  const orgId = overrides.orgId ?? randomUUID()
  const now = new Date().toISOString()
  return {
    orgId,
    async write() {
      await dynamo.send(new PutCommand({
        TableName: tables.orgsTable,
        Item: {
          orgId,
          name: overrides.name ?? 'Test Org',
          plan: 'free',
          seatCount: 1,
          usageLifetimeCount: 0,
          emailDomain: overrides.emailDomain ?? 'example.com',
          createdAt: now,
        },
      }))
      return orgId
    },
  }
}

export function seedUser(
  tables: IntegrationTables,
  params: { orgId: string; userId?: string; email?: string; role?: OrgRole },
) {
  const userId = params.userId ?? randomUUID()
  const now = new Date().toISOString()
  return {
    userId,
    async write() {
      await dynamo.send(new PutCommand({
        TableName: tables.usersTable,
        Item: {
          userId,
          orgId: params.orgId,
          email: params.email ?? `${userId}@example.com`,
          role: params.role ?? 'member',
          passwordSet: true,
          createdAt: now,
        },
      }))
      return userId
    },
  }
}

export async function seedIdentity(tables: IntegrationTables, sub: string, accountId: string) {
  await dynamo.send(new PutCommand({
    TableName: tables.cognitoIdentitiesTable,
    Item: { sub, accountId, linkedAt: new Date().toISOString() },
  }))
}

// Seeds the two system roles (admin/member) for an org — mirrors `ensureOrgRbacSeeded`'s item
// shape exactly (src/lib/rbac.ts) so tests exercise the same key format production code writes.
export async function seedRoles(tables: IntegrationTables, orgId: string): Promise<Record<SystemRoleName, { roleId: string; permissions: Permission[] }>> {
  const now = new Date().toISOString()
  const seeded = {} as Record<SystemRoleName, { roleId: string; permissions: Permission[] }>

  await Promise.all(
    SYSTEM_ROLES.map(async (name) => {
      const seed = DEFAULT_ORG_RBAC_SEED[name]
      const roleId = randomUUID()
      seeded[name] = { roleId, permissions: [...seed.permissions] }
      await dynamo.send(new PutCommand({
        TableName: tables.rolesTable,
        Item: {
          pk: `ORG#${orgId}`,
          sk: `ROLE#${roleId}`,
          orgId,
          roleId,
          name,
          permissions: [...seed.permissions],
          isSystemRole: true,
          createdAt: now,
          updatedAt: now,
        },
      }))
    }),
  )

  return seeded
}

// A custom (non-system) role, for group-mediated-permission tests where the union must reach
// beyond the two seeded system roles.
export async function seedCustomRole(tables: IntegrationTables, orgId: string, permissions: Permission[]) {
  const roleId = randomUUID()
  const now = new Date().toISOString()
  await dynamo.send(new PutCommand({
    TableName: tables.rolesTable,
    Item: {
      pk: `ORG#${orgId}`,
      sk: `ROLE#${roleId}`,
      orgId,
      roleId,
      name: 'Custom Role',
      permissions,
      isSystemRole: false,
      createdAt: now,
      updatedAt: now,
    },
  }))
  return roleId
}

export async function seedGroup(tables: IntegrationTables, orgId: string, roleIds: string[]) {
  const groupId = randomUUID()
  const now = new Date().toISOString()
  await dynamo.send(new PutCommand({
    TableName: tables.groupsTable,
    Item: {
      pk: `ORG#${orgId}`,
      sk: `GROUP#${groupId}`,
      orgId,
      groupId,
      name: 'Test Group',
      roleIds,
      createdAt: now,
      updatedAt: now,
    },
  }))
  return groupId
}

export async function seedRoleAssignment(
  tables: IntegrationTables,
  orgId: string,
  userId: string,
  assignment: { assignmentType: 'role'; roleId: string } | { assignmentType: 'group'; groupId: string },
) {
  const sk = assignment.assignmentType === 'role' ? `ROLE#${assignment.roleId}` : `GROUP#${assignment.groupId}`
  await dynamo.send(new PutCommand({
    TableName: tables.roleAssignmentsTable,
    Item: { pk: `ORG#${orgId}#USER#${userId}`, sk, userId, createdAt: new Date().toISOString(), ...assignment },
  }))
}

// Convenience wrapper: org + admin user + system roles + admin role assignment, in one call —
// the common baseline most integration tests start from.
export async function seedFullOrg(tables: IntegrationTables, overrides: { email?: string } = {}) {
  const org = seedOrg(tables)
  await org.write()
  const admin = seedUser(tables, { orgId: org.orgId, role: 'admin', email: overrides.email })
  await admin.write()
  const roles = await seedRoles(tables, org.orgId)
  await seedRoleAssignment(tables, org.orgId, admin.userId, { assignmentType: 'role', roleId: roles.admin.roleId })
  return { orgId: org.orgId, adminUserId: admin.userId, roles }
}
