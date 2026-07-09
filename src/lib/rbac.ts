import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'crypto'
import { dynamo } from './dynamo.js'
import {
  DEFAULT_ORG_RBAC_SEED,
  SYSTEM_ROLES,
  RoleSchema,
  RoleAssignmentSchema,
  type Role,
  type RoleAssignment,
  type Permission,
  type SystemRoleName,
} from '@heediq/shared'

// Table names are passed in, not imported from ../config.js — this module is shared between the
// main API Lambda (full config) and the separate AuthProvisionFn Lambda (own minimal env vars,
// see auth-provision.ts), which don't have the same env shape.
export type RbacTables = {
  rolesTable: string
  groupsTable: string
  roleAssignmentsTable: string
}

// Seeds the two non-deletable system roles (admin/member) for a brand-new org — called once,
// from auth-provision.ts's new-org branch, at first login (D-102). Returns the seeded roles
// keyed by system role name so the caller can assign the right roleId to the founding user.
export async function ensureOrgRbacSeeded(tables: RbacTables, orgId: string): Promise<Record<SystemRoleName, Role>> {
  const now = new Date().toISOString()
  const seeded = {} as Record<SystemRoleName, Role>

  await Promise.all(
    SYSTEM_ROLES.map(async (name) => {
      const seed = DEFAULT_ORG_RBAC_SEED[name]
      const role: Role = {
        orgId,
        roleId: randomUUID(),
        name,
        permissions: [...seed.permissions],
        isSystemRole: true,
        createdAt: now,
        updatedAt: now,
      }
      seeded[name] = role
      await dynamo.send(new PutCommand({
        TableName: tables.rolesTable,
        Item: { pk: `ORG#${orgId}`, sk: `ROLE#${role.roleId}`, ...role },
      }))
    }),
  )

  return seeded
}

// Direct role assignment for a single user — called for the founding admin at new-org
// provisioning (D-102). Item shape matches routes/role-assignments.ts's POST handler exactly.
export async function ensureUserRoleAssignment(tables: RbacTables, orgId: string, userId: string, roleId: string): Promise<void> {
  const assignment: RoleAssignment = { assignmentType: 'role', userId, roleId, createdAt: new Date().toISOString() }
  await dynamo.send(new PutCommand({
    TableName: tables.roleAssignmentsTable,
    Item: { pk: `ORG#${orgId}#USER#${userId}`, sk: `ROLE#${roleId}`, ...assignment },
  }))
}

// Effective permissions = union of every role reached via a direct assignment or via group
// membership (D-102, no deny rules). Called from auth-provision.ts on every token issuance to
// stamp `custom:permissions` (D-105 — no per-request DB read; this resolution happens only at
// token-issuance time, bounded by the token's natural expiry).
export async function resolveEffectivePermissions(tables: RbacTables, orgId: string, userId: string): Promise<Permission[]> {
  const assignmentsRes = await dynamo.send(new QueryCommand({
    TableName: tables.roleAssignmentsTable,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': `ORG#${orgId}#USER#${userId}` },
  }))
  const assignments = (assignmentsRes.Items ?? []).map((i) => RoleAssignmentSchema.parse(i))

  const roleIds = new Set<string>()
  const groupIds = new Set<string>()
  for (const a of assignments) {
    if (a.assignmentType === 'role') roleIds.add(a.roleId)
    else groupIds.add(a.groupId)
  }

  await Promise.all(
    [...groupIds].map(async (groupId) => {
      const groupRes = await dynamo.send(new GetCommand({
        TableName: tables.groupsTable,
        Key: { pk: `ORG#${orgId}`, sk: `GROUP#${groupId}` },
      }))
      const roleIdsInGroup = (groupRes.Item?.['roleIds'] as string[] | undefined) ?? []
      for (const roleId of roleIdsInGroup) roleIds.add(roleId)
    }),
  )

  const permissions = new Set<Permission>()
  await Promise.all(
    [...roleIds].map(async (roleId) => {
      const roleRes = await dynamo.send(new GetCommand({
        TableName: tables.rolesTable,
        Key: { pk: `ORG#${orgId}`, sk: `ROLE#${roleId}` },
      }))
      if (!roleRes.Item) return
      const role = RoleSchema.parse(roleRes.Item)
      for (const p of role.permissions) permissions.add(p)
    }),
  )

  return [...permissions]
}
