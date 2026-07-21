import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import { dynamo } from '../../src/lib/dynamo.js'
import { config } from '../../src/config.js'
import { seedOrg, seedUser, type IntegrationTables } from './seed.js'
import type { AuthContext } from '../../src/middleware/auth.js'
import type { RequestIdContext } from '../../src/middleware/request-id.js'

// SQS is out of DynamoDB Local scope (D-030 — LocalStack deferred), so only the queue send is
// mocked here — everything else in sources.ts (tier-gate read, jobsTable write) hits real DynamoDB.
const mockSqsSend = vi.hoisted(() => vi.fn().mockResolvedValue({}))
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(() => ({ send: mockSqsSend })),
  SendMessageCommand: vi.fn((input) => input),
}))

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
  app.route('/', sourcesRouter)
  return app
}

async function seedTestOrg(overrides: { plan?: 'free' | 'paid' } = {}) {
  const org = seedOrg(tables)
  await org.write()
  if (overrides.plan) {
    await dynamo.send(new UpdateCommand({
      TableName: config.dynamo.orgsTable,
      Key: { orgId: org.orgId },
      UpdateExpression: 'SET #plan = :plan',
      ExpressionAttributeNames: { '#plan': 'plan' },
      ExpressionAttributeValues: { ':plan': overrides.plan },
    }))
  }
  return org.orgId
}

// PATCH/DELETE resolve the owner's email via a real users-table lookup (sources.ts
// resolveOwnerEmail), so the acting user needs a seeded row — an unseeded userId falls back to
// the literal 'unknown', which fails @heediq/shared's email-format audit payload validation.
async function seedTestUser(orgId: string, role: 'admin' | 'member' = 'admin') {
  const user = seedUser(tables, { orgId, role })
  await user.write()
  return user.userId
}

async function createSource(app: Hono<AuthContext & RequestIdContext>, title = 'Test meeting') {
  const res = await app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  const body = (await res.json()) as { data: { source: { sourceId: string } } }
  return body.data.source.sourceId
}

describe('sources CRUD + pagination (integration, DynamoDB Local)', () => {
  it('creates a source and reads it back', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, randomUUID())
    const sourceId = await createSource(app, 'Kickoff call')

    const res = await app.request(`/${sourceId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { source: { title: string } } }
    expect(body.data.source.title).toBe('Kickoff call')
  })

  it('scopes the list to the caller\'s own sources when they lack sources:read', async () => {
    const orgId = await seedTestOrg()
    const ownerId = randomUUID()
    const otherId = randomUUID()
    const ownerApp = makeApp(orgId, ownerId, 'member', ['sources:create'])
    const otherApp = makeApp(orgId, otherId, 'member', ['sources:create'])

    await createSource(ownerApp, 'Owner source')
    await createSource(otherApp, 'Other source')

    const res = await ownerApp.request('/')
    const body = (await res.json()) as { data: { sources: { title: string }[] } }
    expect(body.data.sources.map((s) => s.title)).toEqual(['Owner source'])
  })

  it('lists all org sources for a caller with sources:read', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, randomUUID(), 'admin')
    await createSource(app, 'A')
    await createSource(app, 'B')

    const res = await app.request('/')
    const body = (await res.json()) as { data: { sources: unknown[] } }
    expect(body.data.sources.length).toBeGreaterThanOrEqual(2)
  })

  it('round-trips the cursor against a real LastEvaluatedKey', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, randomUUID(), 'admin')
    await createSource(app, 'First')
    await createSource(app, 'Second')
    await createSource(app, 'Third')

    const page1Res = await app.request('/?limit=1')
    const page1 = (await page1Res.json()) as { data: { sources: { sourceId: string }[]; nextCursor: string | null } }
    expect(page1.data.sources).toHaveLength(1)
    expect(page1.data.nextCursor).not.toBeNull()

    const page2Res = await app.request(`/?limit=1&cursor=${page1.data.nextCursor}`)
    const page2 = (await page2Res.json()) as { data: { sources: { sourceId: string }[] } }
    expect(page2.data.sources).toHaveLength(1)
    expect(page2.data.sources[0]?.sourceId).not.toBe(page1.data.sources[0]?.sourceId)
  })

  it('updates a source and returns 404 for one that does not exist', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, await seedTestUser(orgId), 'admin')
    const sourceId = await createSource(app)

    const updateRes = await app.request(`/${sourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed' }),
    })
    expect(updateRes.status).toBe(200)

    const missingRes = await app.request(`/${randomUUID()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Ghost' }),
    })
    expect(missingRes.status).toBe(404)
  })

  it('soft-deletes a source and returns 404 for one that does not exist', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, await seedTestUser(orgId), 'admin')
    const sourceId = await createSource(app)

    const deleteRes = await app.request(`/${sourceId}`, { method: 'DELETE' })
    expect(deleteRes.status).toBe(200)

    const missingRes = await app.request(`/${randomUUID()}`, { method: 'DELETE' })
    expect(missingRes.status).toBe(404)
  })

  it('returns 404 for a summary that is not yet available', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, randomUUID(), 'admin')
    const sourceId = await createSource(app)

    const res = await app.request(`/${sourceId}/summary`)
    expect(res.status).toBe(404)
  })

  it('rejects large-v3 on a free-plan org and enqueues on a paid-plan org', async () => {
    const freeOrgId = await seedTestOrg({ plan: 'free' })
    const freeApp = makeApp(freeOrgId, randomUUID(), 'admin')
    const freeSourceId = await createSource(freeApp)
    await dynamo.send(new UpdateCommand({
      TableName: config.dynamo.sourcesTable,
      Key: { orgId: freeOrgId, sourceId: freeSourceId },
      UpdateExpression: 'SET audioS3Key = :key',
      ExpressionAttributeValues: { ':key': 'sources/test/audio' },
    }))

    const rejectedRes = await freeApp.request(`/${freeSourceId}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: freeSourceId, model: 'large-v3' }),
    })
    expect(rejectedRes.status).toBe(403)

    const paidOrgId = await seedTestOrg({ plan: 'paid' })
    const paidApp = makeApp(paidOrgId, randomUUID(), 'admin')
    const paidSourceId = await createSource(paidApp)
    await dynamo.send(new UpdateCommand({
      TableName: config.dynamo.sourcesTable,
      Key: { orgId: paidOrgId, sourceId: paidSourceId },
      UpdateExpression: 'SET audioS3Key = :key',
      ExpressionAttributeValues: { ':key': 'sources/test/audio' },
    }))

    const enqueuedRes = await paidApp.request(`/${paidSourceId}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: paidSourceId, model: 'large-v3' }),
    })
    expect(enqueuedRes.status).toBe(201)
    expect(mockSqsSend).toHaveBeenCalled()
  })

  it('rejects enqueueing a job when the source has no audio uploaded', async () => {
    const orgId = await seedTestOrg()
    const app = makeApp(orgId, randomUUID(), 'admin')
    const sourceId = await createSource(app)

    const res = await app.request(`/${sourceId}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId, model: 'small' }),
    })
    expect(res.status).toBe(400)
  })
})
