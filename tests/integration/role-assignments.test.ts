import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import { roleAssignmentsRouter } from '../../src/routes/role-assignments.js'
import { seedOrg, seedUser, seedCustomRole, seedGroup, type IntegrationTables } from './seed.js'
import type { AuthContext } from '../../src/middleware/auth.js'
import type { RequestIdContext } from '../../src/middleware/request-id.js'

const tables: IntegrationTables = {
  orgsTable: 'heediq-orgs',
  usersTable: 'heediq-users',
  cognitoIdentitiesTable: 'heediq-cognito-identities',
  rolesTable: 'heediq-roles',
  groupsTable: 'heediq-groups',
  roleAssignmentsTable: 'heediq-role-assignments',
}

function makeApp(orgId: string, role: 'admin' | 'member' = 'admin') {
  const app = new Hono<AuthContext & RequestIdContext>()
  app.use('*', async (c, next) => {
    c.set('userId', randomUUID())
    c.set('orgId', orgId)
    c.set('email', 'admin@acme.com')
    c.set('role', role)
    c.set('permissions', [...DEFAULT_ORG_RBAC_SEED[role].permissions])
    c.set('requestId', randomUUID())
    await next()
  })
  app.route('/', roleAssignmentsRouter)
  return app
}

async function seedTestOrgWithTarget() {
  const org = seedOrg(tables)
  await org.write()
  const target = seedUser(tables, { orgId: org.orgId })
  await target.write()
  return { orgId: org.orgId, targetUserId: target.userId }
}

describe('role-assignments CRUD (integration, DynamoDB Local)', () => {
  it('rejects assign from a caller missing org:manage-roles', async () => {
    const { orgId, targetUserId } = await seedTestOrgWithTarget()
    const roleId = await seedCustomRole(tables, orgId, ['audit:read'])
    const res = await makeApp(orgId, 'member').request(`/${targetUserId}/role-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentType: 'role', roleId }),
    })
    expect(res.status).toBe(403)
  })

  it('assigns a direct role and lists it back', async () => {
    const { orgId, targetUserId } = await seedTestOrgWithTarget()
    const roleId = await seedCustomRole(tables, orgId, ['audit:read'])
    const app = makeApp(orgId, 'admin')

    const assignRes = await app.request(`/${targetUserId}/role-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentType: 'role', roleId }),
    })
    expect(assignRes.status).toBe(201)

    const listRes = await app.request(`/${targetUserId}/role-assignments`)
    const listBody = (await listRes.json()) as { data: { roleAssignments: { assignmentType: string; roleId?: string }[] } }
    expect(listBody.data.roleAssignments.some((a) => a.assignmentType === 'role' && a.roleId === roleId)).toBe(true)
  })

  it('assigns a group', async () => {
    const { orgId, targetUserId } = await seedTestOrgWithTarget()
    const roleId = await seedCustomRole(tables, orgId, ['audit:read'])
    const groupId = await seedGroup(tables, orgId, [roleId])
    const app = makeApp(orgId, 'admin')

    const res = await app.request(`/${targetUserId}/role-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentType: 'group', groupId }),
    })
    expect(res.status).toBe(201)
  })

  it('rejects assigning a roleId that does not exist in the org', async () => {
    const { orgId, targetUserId } = await seedTestOrgWithTarget()
    const app = makeApp(orgId, 'admin')

    const res = await app.request(`/${targetUserId}/role-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentType: 'role', roleId: randomUUID() }),
    })
    expect(res.status).toBe(400)
  })

  it('unassigns a direct role and returns 404 on repeat', async () => {
    const { orgId, targetUserId } = await seedTestOrgWithTarget()
    const roleId = await seedCustomRole(tables, orgId, ['audit:read'])
    const app = makeApp(orgId, 'admin')
    await app.request(`/${targetUserId}/role-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentType: 'role', roleId }),
    })

    const deleteRes = await app.request(`/${targetUserId}/role-assignments/role/${roleId}`, { method: 'DELETE' })
    expect(deleteRes.status).toBe(200)

    const missingRes = await app.request(`/${targetUserId}/role-assignments/role/${roleId}`, { method: 'DELETE' })
    expect(missingRes.status).toBe(404)
  })

  it('unassigns a group and returns 404 on repeat', async () => {
    const { orgId, targetUserId } = await seedTestOrgWithTarget()
    const roleId = await seedCustomRole(tables, orgId, ['audit:read'])
    const groupId = await seedGroup(tables, orgId, [roleId])
    const app = makeApp(orgId, 'admin')
    await app.request(`/${targetUserId}/role-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentType: 'group', groupId }),
    })

    const deleteRes = await app.request(`/${targetUserId}/role-assignments/group/${groupId}`, { method: 'DELETE' })
    expect(deleteRes.status).toBe(200)

    const missingRes = await app.request(`/${targetUserId}/role-assignments/group/${groupId}`, { method: 'DELETE' })
    expect(missingRes.status).toBe(404)
  })
})
