import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import type { AuthContext } from '../middleware/auth.js'

const mockDynamoSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    dynamo: {
      rolesTable: 'heediq-roles',
      groupsTable: 'heediq-groups',
      roleAssignmentsTable: 'heediq-role-assignments',
      auditLogTable: 'heediq-audit-log',
      usersTable: 'heediq-users',
    },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

import { auditLogRouter } from '../routes/audit-log.js'

function makeApp(role: 'admin' | 'member' = 'admin') {
  const app = new Hono<AuthContext>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('orgId', orgId)
    c.set('email', 'admin@acme.com')
    c.set('role', role)
    c.set('permissions', [...DEFAULT_ORG_RBAC_SEED[role].permissions])
    await next()
  })
  app.route('/', auditLogRouter)
  return app
}

const now = new Date().toISOString()
const orgId = '00000000-0000-0000-0000-000000000001'
const userId = '00000000-0000-0000-0000-000000000002'
const eventId = '00000000-0000-0000-0000-000000000003'

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    pk: `ORG#${orgId}`,
    sk: `${now}#${eventId}`,
    orgId,
    eventId,
    timestamp: now,
    actorUserId: userId,
    actorEmail: 'admin@acme.com',
    actorRole: 'admin',
    action: 'create',
    resourceType: 'role',
    after: { roleId: eventId, name: 'Reviewer', permissions: [], isSystemRole: false },
    ...overrides,
  }
}

describe('GET /org/audit-log', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a caller missing audit:read', async () => {
    const res = await makeApp('member').request('/')
    expect(res.status).toBe(403)
    // No route-level DB access happens (the handler never runs) — the one call is
    // requirePermission's own denial audit write (D-114), not a route-triggered read/write.
    expect(mockDynamoSend).toHaveBeenCalledTimes(1)
  })

  it('queries the base table scoped to the caller org when no filters given', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    await makeApp('admin').request('/')
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: 'heediq-audit-log',
          IndexName: undefined,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': `ORG#${orgId}` },
        }),
      }),
    )
  })

  it('builds an sk BETWEEN condition when a date range is given', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    await makeApp('admin').request('/?from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z')
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
          ExpressionAttributeValues: expect.objectContaining({
            ':from': '2026-01-01T00:00:00.000Z',
            ':to': '2026-01-31T00:00:00.000Z￿',
          }),
        }),
      }),
    )
  })

  it('queries the by-user GSI and re-asserts orgId when actorUserId filter is given', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    await makeApp('admin').request(`/?actorUserId=${userId}`)
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          IndexName: 'by-user',
          KeyConditionExpression: 'actorUserId = :actorUserId',
          FilterExpression: 'orgId = :orgId',
          ExpressionAttributeValues: expect.objectContaining({
            ':actorUserId': userId,
            ':orgId': orgId,
          }),
        }),
      }),
    )
  })

  it('combines action and resourceType into an ANDed FilterExpression', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    await makeApp('admin').request('/?action=create&resourceType=role')
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          FilterExpression: '#action = :action AND resourceType = :resourceType',
          ExpressionAttributeNames: { '#action': 'action' },
          ExpressionAttributeValues: expect.objectContaining({ ':action': 'create', ':resourceType': 'role' }),
        }),
      }),
    )
  })

  it('returns entries parsed through the schema and no nextCursor when fewer than limit+1 rows', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [makeEntry()] })
    const res = await makeApp('admin').request('/')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { entries: unknown[]; nextCursor: string | null } }
    expect(body.data.entries).toHaveLength(1)
    expect(body.data.nextCursor).toBeNull()
  })

  it('round-trips the cursor: encodes LastEvaluatedKey on response, decodes it into ExclusiveStartKey on request', async () => {
    const lastKey = { pk: `ORG#${orgId}`, sk: `${now}#${eventId}` }
    mockDynamoSend.mockResolvedValueOnce({
      Items: [makeEntry(), makeEntry({ eventId: 'evt-2', sk: `${now}#evt-2` })],
      LastEvaluatedKey: lastKey,
    })
    const res = await makeApp('admin').request('/?limit=1')
    const body = await res.json() as { data: { entries: unknown[]; nextCursor: string | null } }
    expect(body.data.entries).toHaveLength(1)
    expect(body.data.nextCursor).not.toBeNull()

    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    await makeApp('admin').request(`/?cursor=${body.data.nextCursor}`)
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ ExclusiveStartKey: lastKey }),
      }),
    )
  })
})
