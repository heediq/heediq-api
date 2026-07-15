import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import { rolesRouter } from '../../../src/routes/roles.js'
import { groupsRouter } from '../../../src/routes/groups.js'
import { roleAssignmentsRouter } from '../../../src/routes/role-assignments.js'
import { auditLogRouter } from '../../../src/routes/audit-log.js'
import { resolveEffectivePermissions } from '../../../src/lib/rbac.js'
import { seedOrg, seedUser, type IntegrationTables } from '../seed.js'
import type { AuthContext } from '../../../src/middleware/auth.js'
import type { RequestIdContext } from '../../../src/middleware/request-id.js'

// Exercises the same journey an admin performs from the UI: define a custom role, bundle it into
// a group, assign the group to a user, then confirm both the resolved permissions and the audit
// trail reflect every step — a single route's integration test can't catch a break in how these
// four routes compose (e.g. a group referencing a role integration test data shape mismatch).
const tables: IntegrationTables = {
  orgsTable: 'heediq-orgs',
  usersTable: 'heediq-users',
  cognitoIdentitiesTable: 'heediq-cognito-identities',
  rolesTable: 'heediq-roles',
  groupsTable: 'heediq-groups',
  roleAssignmentsTable: 'heediq-role-assignments',
}

function makeApp(orgId: string, actorUserId: string) {
  const app = new Hono<AuthContext & RequestIdContext>()
  app.use('*', async (c, next) => {
    c.set('userId', actorUserId)
    c.set('orgId', orgId)
    c.set('email', 'admin@acme.com')
    c.set('role', 'admin')
    c.set('permissions', [...DEFAULT_ORG_RBAC_SEED.admin.permissions])
    c.set('requestId', randomUUID())
    await next()
  })
  app.route('/roles', rolesRouter)
  app.route('/groups', groupsRouter)
  app.route('/users', roleAssignmentsRouter)
  app.route('/org/audit-log', auditLogRouter)
  return app
}

describe('RBAC journey: role -> group -> assignment -> permissions -> audit trail (integration, DynamoDB Local)', () => {
  it('carries a custom role through to a target user\'s effective permissions and the audit log', async () => {
    const org = seedOrg(tables)
    await org.write()
    const target = seedUser(tables, { orgId: org.orgId })
    await target.write()
    const app = makeApp(org.orgId, randomUUID())

    const createRoleRes = await app.request('/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Auditor', permissions: ['audit:read'] }),
    })
    expect(createRoleRes.status).toBe(201)
    const roleBody = (await createRoleRes.json()) as { data: { role: { roleId: string } } }
    const roleId = roleBody.data.role.roleId

    const createGroupRes = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Auditors', roleIds: [roleId] }),
    })
    expect(createGroupRes.status).toBe(201)
    const groupBody = (await createGroupRes.json()) as { data: { group: { groupId: string } } }
    const groupId = groupBody.data.group.groupId

    const assignRes = await app.request(`/users/${target.userId}/role-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentType: 'group', groupId }),
    })
    expect(assignRes.status).toBe(201)

    const effectivePermissions = await resolveEffectivePermissions(tables, org.orgId, target.userId)
    expect(effectivePermissions).toContain('audit:read')

    const auditRes = await app.request('/org/audit-log')
    expect(auditRes.status).toBe(200)
    const auditBody = (await auditRes.json()) as { data: { entries: { action: string; resourceType: string }[] } }
    const actions = auditBody.data.entries.map((e) => `${e.resourceType}:${e.action}`)
    expect(actions).toContain('role:role:create')
    expect(actions).toContain('group:group:create')
    expect(actions).toContain('groupAssignment:groupAssignment:create')
  })
})
