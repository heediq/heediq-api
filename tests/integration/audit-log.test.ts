import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../../src/lib/dynamo.js'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import { auditLogRouter } from '../../src/routes/audit-log.js'
import type { AuthContext } from '../../src/middleware/auth.js'
import type { RequestIdContext } from '../../src/middleware/request-id.js'

const orgId = randomUUID()
const userId = randomUUID()
const AUDIT_LOG_TABLE = 'heediq-audit-log'

// Mounts the real router (real dynamo -> DynamoDB Local) with a synthetic auth context, the same
// approach as the mocked unit test (src/__tests__/audit-log.test.ts) — bypasses authMiddleware's
// real Cognito JWKS round-trip, which integration tests can't drive without a live user pool.
function makeApp(role: 'admin' | 'member' = 'admin') {
  const app = new Hono<AuthContext & RequestIdContext>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('orgId', orgId)
    c.set('email', 'admin@acme.com')
    c.set('role', role)
    c.set('permissions', [...DEFAULT_ORG_RBAC_SEED[role].permissions])
    c.set('requestId', randomUUID())
    await next()
  })
  app.route('/', auditLogRouter)
  return app
}

// sk must always be derived from this same entry's timestamp — the route orders/pages by sk
// (ScanIndexForward: false), so a seed whose sk disagrees with its own timestamp field breaks the
// sk-order == timestamp-order invariant the route relies on, once any other row shares this org
// (e.g. requirePermission's D-114 denial-audit write from an earlier test in this file).
async function seedEntry(overrides: { timestamp?: string; action?: string; resourceType?: string } = {}) {
  const eventId = randomUUID()
  const timestamp = overrides.timestamp ?? new Date().toISOString()
  await dynamo.send(new PutCommand({
    TableName: AUDIT_LOG_TABLE,
    Item: {
      pk: `ORG#${orgId}`,
      sk: `${timestamp}#${eventId}`,
      orgId,
      eventId,
      timestamp,
      actorUserId: userId,
      actorEmail: 'admin@acme.com',
      actorRole: 'admin',
      action: overrides.action ?? 'create',
      resourceType: overrides.resourceType ?? 'role',
      after: { roleId: eventId, name: 'Reviewer', permissions: [], isSystemRole: false },
    },
  }))
}

describe('GET /org/audit-log (integration, DynamoDB Local)', () => {
  it('rejects a caller missing audit:read', async () => {
    const res = await makeApp('member').request('/')
    expect(res.status).toBe(403)
  })

  it('lists entries scoped to the caller org, most recent first', async () => {
    await seedEntry({ timestamp: '2026-01-01T00:00:00.000Z' })
    await seedEntry({ timestamp: '2026-01-02T00:00:00.000Z' })

    const res = await makeApp('admin').request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { entries: { timestamp: string }[] } }
    expect(body.data.entries.length).toBeGreaterThanOrEqual(2)
    const sks = body.data.entries.map((e) => e.timestamp)
    expect(sks).toEqual([...sks].sort().reverse())
  })

  it('filters by action and resourceType', async () => {
    const isolatedOrg = randomUUID()
    const eventId = randomUUID()
    await dynamo.send(new PutCommand({
      TableName: AUDIT_LOG_TABLE,
      Item: {
        pk: `ORG#${isolatedOrg}`,
        sk: `${new Date().toISOString()}#${eventId}`,
        orgId: isolatedOrg,
        eventId,
        timestamp: new Date().toISOString(),
        actorUserId: userId,
        actorEmail: 'admin@acme.com',
        actorRole: 'admin',
        action: 'delete',
        resourceType: 'group',
        before: { groupId: eventId, name: 'Old Group', roleIds: [] },
      },
    }))
    // Not visible from the default org's app instance — cross-org isolation.
    const res = await makeApp('admin').request('/?action=delete&resourceType=group')
    const body = (await res.json()) as { data: { entries: unknown[] } }
    expect(body.data.entries).toHaveLength(0)
  })

  it('round-trips the cursor against a real LastEvaluatedKey', async () => {
    const pageOrgApp = makeApp('admin')
    for (let i = 0; i < 3; i++) {
      await seedEntry({ timestamp: `2026-02-0${i + 1}T00:00:00.000Z` })
    }

    const res = await pageOrgApp.request('/?limit=1&from=2026-02-01T00:00:00.000Z&to=2026-02-03T23:59:59.999Z')
    const body = (await res.json()) as { data: { entries: { timestamp: string }[]; nextCursor: string | null } }
    expect(body.data.entries).toHaveLength(1)
    expect(body.data.nextCursor).not.toBeNull()

    const res2 = await pageOrgApp.request(
      `/?limit=1&cursor=${body.data.nextCursor}&from=2026-02-01T00:00:00.000Z&to=2026-02-03T23:59:59.999Z`,
    )
    const body2 = (await res2.json()) as { data: { entries: { timestamp: string }[] } }
    expect(body2.data.entries).toHaveLength(1)
    expect(body2.data.entries[0]?.timestamp).not.toBe(body.data.entries[0]?.timestamp)
  })
})
