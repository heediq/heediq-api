import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import { rolesRouter } from '../../src/routes/roles.js'
import { seedOrg, seedRoles, seedCustomRole, type IntegrationTables } from './seed.js'
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

// Mounts the real router (real dynamo -> DynamoDB Local) with a synthetic auth context — same
// approach as tests/integration/audit-log.test.ts.
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
  app.route('/', rolesRouter)
  return app
}

async function seedTestOrg() {
  const org = seedOrg(tables)
  await org.write()
  return org.orgId
}

describe('roles CRUD (integration, DynamoDB Local)', () => {
  it('rejects create from a caller missing org:manage-roles', async () => {
    const orgId = await seedTestOrg()
    const res = await makeApp(orgId, 'member').request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reviewer', permissions: [] }),
    })
    expect(res.status).toBe(403)
  })

  it('creates a role and lists it back scoped to the org', async () => {
    const orgId = await seedTestOrg()
    const otherOrgId = await seedTestOrg()
    const app = makeApp(orgId, 'admin')

    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reviewer', permissions: ['audit:read'] }),
    })
    expect(createRes.status).toBe(201)

    const listRes = await app.request('/')
    const listBody = (await listRes.json()) as { data: { roles: { name: string }[] } }
    expect(listBody.data.roles.some((r) => r.name === 'Reviewer')).toBe(true)

    // Cross-org isolation: the other org's app instance never sees this role.
    const otherListRes = await makeApp(otherOrgId, 'admin').request('/')
    const otherListBody = (await otherListRes.json()) as { data: { roles: { name: string }[] } }
    expect(otherListBody.data.roles.some((r) => r.name === 'Reviewer')).toBe(false)
  })

  it('updates a role and returns 404 for a role that does not exist', async () => {
    const orgId = await seedTestOrg()
    const roleId = await seedCustomRole(tables, orgId, ['audit:read'])
    const app = makeApp(orgId, 'admin')

    const updateRes = await app.request(`/${roleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Reviewer' }),
    })
    expect(updateRes.status).toBe(200)
    const updateBody = (await updateRes.json()) as { data: { role: { name: string } } }
    expect(updateBody.data.role.name).toBe('Renamed Reviewer')

    const missingRes = await app.request(`/${randomUUID()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ghost' }),
    })
    expect(missingRes.status).toBe(404)
  })

  it('deletes a custom role and returns 404 for a role that does not exist', async () => {
    const orgId = await seedTestOrg()
    const roleId = await seedCustomRole(tables, orgId, ['audit:read'])
    const app = makeApp(orgId, 'admin')

    const deleteRes = await app.request(`/${roleId}`, { method: 'DELETE' })
    expect(deleteRes.status).toBe(200)

    const missingRes = await app.request(`/${roleId}`, { method: 'DELETE' })
    expect(missingRes.status).toBe(404)
  })

  it('blocks deleting a system role with 409', async () => {
    const orgId = await seedTestOrg()
    const roles = await seedRoles(tables, orgId)
    const app = makeApp(orgId, 'admin')

    const res = await app.request(`/${roles.admin.roleId}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
  })
})
