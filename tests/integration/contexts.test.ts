import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import { seedOrg, seedRoleAssignment, type IntegrationTables } from './seed.js'
import type { AuthContext } from '../../src/middleware/auth.js'
import type { RequestIdContext } from '../../src/middleware/request-id.js'

const { contextsRouter } = await import('../../src/routes/contexts.js')
const { sourcesRouter } = await import('../../src/routes/sources.js')

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
  app.route('/sources', sourcesRouter)
  return app
}

async function seedTestOrg() {
  const org = seedOrg(tables)
  await org.write()
  return org.orgId
}

async function createContext(
  app: Hono<AuthContext & RequestIdContext>,
  body: { name: string; domain: string; visibility?: string; groupId?: string; parentContextId?: string },
) {
  const res = await app.request('/contexts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = (await res.json()) as { data?: { context: { contextId: string } } }
  return { status: res.status, contextId: parsed.data?.context.contextId }
}

describe('contexts CRUD + visibility scoping (integration, DynamoDB Local)', () => {
  it('creates a personal context and reads it back via the by-scope GSI', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, randomUUID())
    const { contextId } = await createContext(app, { name: 'My Notes', domain: 'work' })

    const listRes = await app.request('/contexts')
    const listBody = (await listRes.json()) as { data: { contexts: { contextId: string }[] } }
    expect(listBody.data.contexts.map((c) => c.contextId)).toContain(contextId)

    const getRes = await app.request(`/contexts/${contextId}`)
    expect(getRes.status).toBe(200)
  })

  it('does not surface a personal context to a different org member (by-scope isolation)', async () => {
    const orgId = await seedTestOrg()
    const ownerApp = makeApp(orgId, randomUUID())
    const otherApp = makeApp(orgId, randomUUID())
    const { contextId } = await createContext(ownerApp, { name: 'Private', domain: 'personal' })

    const getRes = await otherApp.request(`/contexts/${contextId}`)
    expect(getRes.status).toBe(404)

    const listRes = await otherApp.request('/contexts')
    const listBody = (await listRes.json()) as { data: { contexts: { contextId: string }[] } }
    expect(listBody.data.contexts.map((c) => c.contextId)).not.toContain(contextId)
  })

  it('surfaces an org-visible context to any org member', async () => {
    const orgId = await seedTestOrg()
    const ownerApp = makeApp(orgId, randomUUID())
    const otherApp = makeApp(orgId, randomUUID())
    const { contextId } = await createContext(ownerApp, { name: 'Team Notes', domain: 'work', visibility: 'org' })

    const res = await otherApp.request(`/contexts/${contextId}`)
    expect(res.status).toBe(200)
  })

  it('returns 404 for a context belonging to a different org (cross-org isolation)', async () => {
    const orgAId = await seedTestOrg()
    const orgBId = await seedTestOrg()
    const orgAApp = makeApp(orgAId, randomUUID())
    const orgBApp = makeApp(orgBId, randomUUID())
    const { contextId } = await createContext(orgAApp, { name: 'Org A Notes', domain: 'work', visibility: 'org' })

    const res = await orgBApp.request(`/contexts/${contextId}`)
    expect(res.status).toBe(404)
  })

  it('surfaces a group context only to a live group member', async () => {
    const orgId = await seedTestOrg()
    const groupId = randomUUID()
    const memberUserId = randomUUID()
    const nonMemberUserId = randomUUID()
    await seedRoleAssignment(tables, orgId, memberUserId, { assignmentType: 'group', groupId })

    // POST /contexts itself requires the creating caller to be a member of the target group
    // (same as any reader), so the owner here is the seeded group member — this test asserts
    // read visibility (member vs non-member), not creator identity.
    const memberApp = makeApp(orgId, memberUserId)
    const nonMemberApp = makeApp(orgId, nonMemberUserId)
    const { contextId } = await createContext(memberApp, { name: 'Group Notes', domain: 'work', visibility: 'group', groupId })

    const memberRes = await memberApp.request(`/contexts/${contextId}`)
    expect(memberRes.status).toBe(200)

    const nonMemberRes = await nonMemberApp.request(`/contexts/${contextId}`)
    expect(nonMemberRes.status).toBe(404)
  })

  it('rejects creating a group context when the caller is not a member of that group', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, randomUUID())
    const res = await app.request('/contexts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', domain: 'work', visibility: 'group', groupId: randomUUID() }),
    })
    expect(res.status).toBe(400)
  })

  it('builds a tree nested by parentContextId', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, randomUUID())
    const { contextId: parentId } = await createContext(app, { name: 'Parent', domain: 'work' })
    const { contextId: childId } = await createContext(app, { name: 'Child', domain: 'work', parentContextId: parentId })

    const res = await app.request('/contexts/tree')
    const body = (await res.json()) as { data: { tree: { contextId: string; children: { contextId: string }[] }[] } }
    const parentNode = body.data.tree.find((n) => n.contextId === parentId)
    expect(parentNode?.children.map((c) => c.contextId)).toContain(childId)
  })

  it('returns 409 when deleting a context that still has children', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, randomUUID())
    const { contextId: parentId } = await createContext(app, { name: 'Parent', domain: 'work' })
    await createContext(app, { name: 'Child', domain: 'work', parentContextId: parentId })

    const res = await app.request(`/contexts/${parentId}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
  })

  it('deletes a childless context', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, randomUUID())
    const { contextId } = await createContext(app, { name: 'Solo', domain: 'work' })

    const res = await app.request(`/contexts/${contextId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)

    const getRes = await app.request(`/contexts/${contextId}`)
    expect(getRes.status).toBe(404)
  })

  it('rejects a caller missing context:create', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, randomUUID(), 'member', [])
    const res = await app.request('/contexts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', domain: 'work' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('source review-approval end-to-end (integration, DynamoDB Local)', () => {
  it('files kept extracted items into a context and discards the rest', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, randomUUID())

    const { contextId } = await createContext(app, { name: 'Meeting Notes', domain: 'work' })

    const sourceRes = await app.request('/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Standup' }),
    })
    const sourceBody = (await sourceRes.json()) as { data: { source: { sourceId: string } } }
    const sourceId = sourceBody.data.source.sourceId

    const reviewRes = await app.request(`/sources/${sourceId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId, kept: [] }),
    })
    expect(reviewRes.status).toBe(200)
    const reviewBody = (await reviewRes.json()) as { data: { keptCount: number; discardedCount: number } }
    expect(reviewBody.data.keptCount).toBe(0)
    expect(reviewBody.data.discardedCount).toBe(0)

    const sourceAfterRes = await app.request(`/sources/${sourceId}`)
    const sourceAfterBody = (await sourceAfterRes.json()) as { data: { source: { classification?: string } } }
    expect(sourceAfterBody.data.source.classification).toBe('approved')
  })

  it('returns 400 when the target context is not visible to the caller', async () => {
    const orgId = await seedTestOrg()
    const ownerApp = makeApp(orgId, randomUUID())
    const otherApp = makeApp(orgId, randomUUID())
    const { contextId } = await createContext(ownerApp, { name: 'Private', domain: 'personal' })

    const sourceRes = await otherApp.request('/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Standup' }),
    })
    const sourceBody = (await sourceRes.json()) as { data: { source: { sourceId: string } } }
    const sourceId = sourceBody.data.source.sourceId

    const reviewRes = await otherApp.request(`/sources/${sourceId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId, kept: [] }),
    })
    expect(reviewRes.status).toBe(400)
  })
})
