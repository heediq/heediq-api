import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import { seedOrg, seedUser, type IntegrationTables } from './seed.js'
import type { AuthContext } from '../../src/middleware/auth.js'
import type { RequestIdContext } from '../../src/middleware/request-id.js'

const { contextsRouter } = await import('../../src/routes/contexts.js')
const { contextGrantsRouter } = await import('../../src/routes/context-grants.js')

const tables: IntegrationTables = {
  orgsTable: 'heediq-orgs',
  usersTable: 'heediq-users',
  cognitoIdentitiesTable: 'heediq-cognito-identities',
  rolesTable: 'heediq-roles',
  groupsTable: 'heediq-groups',
  roleAssignmentsTable: 'heediq-role-assignments',
}

function makeApp(orgId: string, userId: string, role: 'admin' | 'member' = 'admin', permissions?: string[]) {
  const app = new Hono<AuthContext & RequestIdContext>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('orgId', orgId)
    c.set('email', 'admin@acme.com')
    c.set('role', role)
    c.set('permissions', (permissions ?? [...DEFAULT_ORG_RBAC_SEED[role].permissions]) as never)
    c.set('requestId', randomUUID())
    await next()
  })
  app.route('/contexts', contextsRouter)
  app.route('/context-grants', contextGrantsRouter)
  return app
}

async function seedTestOrg() {
  const org = seedOrg(tables)
  await org.write()
  return org.orgId
}

async function createContext(
  app: Hono<AuthContext & RequestIdContext>,
  body: { name: string; domain: string; visibility?: string },
) {
  const res = await app.request('/contexts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = (await res.json()) as { data?: { context: { contextId: string } } }
  return { status: res.status, contextId: parsed.data?.context.contextId as string }
}

const FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 3600

async function seedGrantee(orgId: string): Promise<{ userId: string; email: string }> {
  const email = `grantee-${randomUUID()}@other.com`
  const user = seedUser(tables, { orgId, email })
  const userId = await user.write()
  return { userId, email }
}

describe('cross-org context grants (integration, DynamoDB Local, D-142)', () => {
  it('issues a grant to a user in another org and the grantee can read the context', async () => {
    const ownerOrgId = await seedTestOrg()
    const granteeOrgId = await seedTestOrg()
    const grantee = await seedGrantee(granteeOrgId)

    const ownerApp = makeApp(ownerOrgId, randomUUID())
    const { contextId } = await createContext(ownerApp, { name: 'Shared Project', domain: 'work' })

    const shareRes = await ownerApp.request(`/context-grants?contextId=${contextId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granteeEmail: grantee.email, access: 'read', expiresAt: FUTURE_EXPIRY }),
    })
    expect(shareRes.status).toBe(201)

    const granteeApp = makeApp(granteeOrgId, grantee.userId, 'member', [])
    const getRes = await granteeApp.request(`/contexts/${contextId}`)
    expect(getRes.status).toBe(200)
  })

  it('rejects sharing to an email with no existing Heediq account', async () => {
    const ownerOrgId = await seedTestOrg()
    const ownerApp = makeApp(ownerOrgId, randomUUID())
    const { contextId } = await createContext(ownerApp, { name: 'Shared', domain: 'work' })

    const shareRes = await ownerApp.request(`/context-grants?contextId=${contextId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granteeEmail: 'nobody@nowhere.com', access: 'read', expiresAt: FUTURE_EXPIRY }),
    })
    expect(shareRes.status).toBe(400)
  })

  it('rejects sharing to a same-org email (grants are cross-org only)', async () => {
    const orgId = await seedTestOrg()
    const teammateEmail = `teammate-${randomUUID()}@acme.com`
    await seedUser(tables, { orgId, email: teammateEmail }).write()
    const ownerApp = makeApp(orgId, randomUUID())
    const { contextId } = await createContext(ownerApp, { name: 'Shared', domain: 'work' })

    const shareRes = await ownerApp.request(`/context-grants?contextId=${contextId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granteeEmail: teammateEmail, access: 'read', expiresAt: FUTURE_EXPIRY }),
    })
    expect(shareRes.status).toBe(400)
  })

  it('rejects a caller missing context:share (member default seed)', async () => {
    const ownerOrgId = await seedTestOrg()
    const granteeOrgId = await seedTestOrg()
    const grantee = await seedGrantee(granteeOrgId)

    const memberApp = makeApp(ownerOrgId, randomUUID(), 'member')
    const { contextId } = await createContext(memberApp, { name: 'Shared', domain: 'work', visibility: 'org' })

    const shareRes = await memberApp.request(`/context-grants?contextId=${contextId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granteeEmail: grantee.email, access: 'read', expiresAt: FUTURE_EXPIRY }),
    })
    expect(shareRes.status).toBe(403)
  })

  it('a read grant does not authorize contribute-tier access (source review)', async () => {
    const ownerOrgId = await seedTestOrg()
    const granteeOrgId = await seedTestOrg()
    const grantee = await seedGrantee(granteeOrgId)

    const ownerApp = makeApp(ownerOrgId, randomUUID())
    const { contextId } = await createContext(ownerApp, { name: 'Shared', domain: 'work' })
    await ownerApp.request(`/context-grants?contextId=${contextId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granteeEmail: grantee.email, access: 'read', expiresAt: FUTURE_EXPIRY }),
    })

    const { sourcesRouter } = await import('../../src/routes/sources.js')
    const granteeApp = makeApp(granteeOrgId, grantee.userId, 'member')
    granteeApp.route('/sources', sourcesRouter)

    const sourceRes = await granteeApp.request('/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Notes' }),
    })
    const sourceBody = (await sourceRes.json()) as { data: { source: { sourceId: string } } }

    const reviewRes = await granteeApp.request(`/sources/${sourceBody.data.source.sourceId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId, kept: [] }),
    })
    expect(reviewRes.status).toBe(400)
  })

  it('a contribute grant authorizes filing reviewed items into the shared context', async () => {
    const ownerOrgId = await seedTestOrg()
    const granteeOrgId = await seedTestOrg()
    const grantee = await seedGrantee(granteeOrgId)

    const ownerApp = makeApp(ownerOrgId, randomUUID())
    const { contextId } = await createContext(ownerApp, { name: 'Shared', domain: 'work' })
    await ownerApp.request(`/context-grants?contextId=${contextId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granteeEmail: grantee.email, access: 'contribute', expiresAt: FUTURE_EXPIRY }),
    })

    const { sourcesRouter } = await import('../../src/routes/sources.js')
    const granteeApp = makeApp(granteeOrgId, grantee.userId, 'member')
    granteeApp.route('/sources', sourcesRouter)

    const sourceRes = await granteeApp.request('/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Notes' }),
    })
    const sourceBody = (await sourceRes.json()) as { data: { source: { sourceId: string } } }

    const reviewRes = await granteeApp.request(`/sources/${sourceBody.data.source.sourceId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId, kept: [] }),
    })
    expect(reviewRes.status).toBe(200)
  })

  it('a revoked grant immediately loses access (no JWT caching)', async () => {
    const ownerOrgId = await seedTestOrg()
    const granteeOrgId = await seedTestOrg()
    const grantee = await seedGrantee(granteeOrgId)

    const ownerApp = makeApp(ownerOrgId, randomUUID())
    const { contextId } = await createContext(ownerApp, { name: 'Shared', domain: 'work' })
    await ownerApp.request(`/context-grants?contextId=${contextId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granteeEmail: grantee.email, access: 'read', expiresAt: FUTURE_EXPIRY }),
    })

    const granteeApp = makeApp(granteeOrgId, grantee.userId, 'member', [])
    expect((await granteeApp.request(`/contexts/${contextId}`)).status).toBe(200)

    const revokeRes = await ownerApp.request(`/context-grants/${contextId}/${grantee.userId}`, { method: 'DELETE' })
    expect(revokeRes.status).toBe(200)

    expect((await granteeApp.request(`/contexts/${contextId}`)).status).toBe(404)
  })

  it('lists grants for a context (owner view) and the grantee\'s shared-with-me view', async () => {
    const ownerOrgId = await seedTestOrg()
    const granteeOrgId = await seedTestOrg()
    const grantee = await seedGrantee(granteeOrgId)

    const ownerApp = makeApp(ownerOrgId, randomUUID())
    const { contextId } = await createContext(ownerApp, { name: 'Shared', domain: 'work' })
    await ownerApp.request(`/context-grants?contextId=${contextId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granteeEmail: grantee.email, access: 'read', expiresAt: FUTURE_EXPIRY }),
    })

    const ownerListRes = await ownerApp.request(`/context-grants?contextId=${contextId}`)
    const ownerListBody = (await ownerListRes.json()) as { data: { grants: { granteeUserId: string }[] } }
    expect(ownerListBody.data.grants.map((g) => g.granteeUserId)).toContain(grantee.userId)

    const granteeApp = makeApp(granteeOrgId, grantee.userId, 'member', [])
    const sharedRes = await granteeApp.request('/context-grants/shared-with-me')
    const sharedBody = (await sharedRes.json()) as { data: { grants: { contextId: string }[] } }
    expect(sharedBody.data.grants.map((g) => g.contextId)).toContain(contextId)
  })

  it('returns 404 revoking a grant that belongs to a different owner org', async () => {
    const ownerOrgId = await seedTestOrg()
    const otherOrgId = await seedTestOrg()
    const granteeOrgId = await seedTestOrg()
    const grantee = await seedGrantee(granteeOrgId)

    const ownerApp = makeApp(ownerOrgId, randomUUID())
    const { contextId } = await createContext(ownerApp, { name: 'Shared', domain: 'work' })
    await ownerApp.request(`/context-grants?contextId=${contextId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granteeEmail: grantee.email, access: 'read', expiresAt: FUTURE_EXPIRY }),
    })

    const otherOrgApp = makeApp(otherOrgId, randomUUID())
    const revokeRes = await otherOrgApp.request(`/context-grants/${contextId}/${grantee.userId}`, { method: 'DELETE' })
    expect(revokeRes.status).toBe(404)
  })
})
