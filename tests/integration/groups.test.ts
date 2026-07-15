import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import { groupsRouter } from '../../src/routes/groups.js'
import { seedOrg, seedCustomRole, type IntegrationTables } from './seed.js'
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
  app.route('/', groupsRouter)
  return app
}

async function seedTestOrg() {
  const org = seedOrg(tables)
  await org.write()
  return org.orgId
}

describe('groups CRUD (integration, DynamoDB Local)', () => {
  it('rejects create from a caller missing org:manage-roles', async () => {
    const orgId = await seedTestOrg()
    const roleId = await seedCustomRole(tables, orgId, ['audit:read'])
    const res = await makeApp(orgId, 'member').request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reviewers', roleIds: [roleId] }),
    })
    expect(res.status).toBe(403)
  })

  it('creates a group referencing a real in-org role', async () => {
    const orgId = await seedTestOrg()
    const roleId = await seedCustomRole(tables, orgId, ['audit:read'])
    const app = makeApp(orgId, 'admin')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reviewers', roleIds: [roleId] }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { group: { roleIds: string[] } } }
    expect(body.data.group.roleIds).toEqual([roleId])
  })

  it('dedupes duplicate roleIds and still creates the group', async () => {
    const orgId = await seedTestOrg()
    const roleId = await seedCustomRole(tables, orgId, ['audit:read'])
    const app = makeApp(orgId, 'admin')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reviewers', roleIds: [roleId, roleId] }),
    })
    expect(res.status).toBe(201)
  })

  it('rejects a roleId that does not exist', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, 'admin')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reviewers', roleIds: [randomUUID()] }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a roleId that belongs to another org (cross-org isolation)', async () => {
    const orgId = await seedTestOrg()
    const otherOrgId = await seedTestOrg()
    const otherOrgRoleId = await seedCustomRole(tables, otherOrgId, ['audit:read'])
    const app = makeApp(orgId, 'admin')

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reviewers', roleIds: [otherOrgRoleId] }),
    })
    expect(res.status).toBe(400)
  })

  it('updates a group and returns 404 for a group that does not exist', async () => {
    const orgId = await seedTestOrg()
    const roleId = await seedCustomRole(tables, orgId, ['audit:read'])
    const app = makeApp(orgId, 'admin')
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reviewers', roleIds: [roleId] }),
    })
    const createBody = (await createRes.json()) as { data: { group: { groupId: string } } }
    const groupId = createBody.data.group.groupId

    const updateRes = await app.request(`/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Reviewers' }),
    })
    expect(updateRes.status).toBe(200)

    const missingRes = await app.request(`/${randomUUID()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ghost' }),
    })
    expect(missingRes.status).toBe(404)
  })

  it('deletes a group and returns 404 for a group that does not exist', async () => {
    const orgId = await seedTestOrg()
    const roleId = await seedCustomRole(tables, orgId, ['audit:read'])
    const app = makeApp(orgId, 'admin')
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reviewers', roleIds: [roleId] }),
    })
    const createBody = (await createRes.json()) as { data: { group: { groupId: string } } }
    const groupId = createBody.data.group.groupId

    const deleteRes = await app.request(`/${groupId}`, { method: 'DELETE' })
    expect(deleteRes.status).toBe(200)

    const missingRes = await app.request(`/${groupId}`, { method: 'DELETE' })
    expect(missingRes.status).toBe(404)
  })
})
