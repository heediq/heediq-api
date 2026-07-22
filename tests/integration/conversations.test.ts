import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { DEFAULT_ORG_RBAC_SEED } from '@heediq/shared'
import { dynamo } from '../../src/lib/dynamo.js'
import { config } from '../../src/config.js'
import { seedOrg, seedUser, type IntegrationTables } from './seed.js'
import type { AuthContext } from '../../src/middleware/auth.js'
import type { RequestIdContext } from '../../src/middleware/request-id.js'

// SQS is out of DynamoDB Local scope (D-030 — LocalStack deferred, same as sources.test.ts) — only
// the queue send is mocked; the Conversation/ChatMessage reads/writes and the org-plan tier lookup
// all hit real DynamoDB.
const mockSqsSend = vi.hoisted(() => vi.fn().mockResolvedValue({}))
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(() => ({ send: mockSqsSend })),
  SendMessageCommand: vi.fn((input) => input),
}))

const { contextsRouter } = await import('../../src/routes/contexts.js')
const { conversationsRouter } = await import('../../src/routes/conversations.js')

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
  app.route('/conversations', conversationsRouter)
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

describe('Context chat — conversations and messages (integration, DynamoDB Local, D-138/D-139)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a conversation, lists it, posts a message, and enqueues a chat job at the org tier', async () => {
    const orgId = await seedTestOrg({ plan: 'paid' })
    const userId = randomUUID()
    const app = makeApp(orgId, userId)
    const { contextId } = await createContext(app, { name: 'Project X', domain: 'work' })

    const createRes = await app.request(`/conversations?contextId=${contextId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Kickoff thread' }),
    })
    expect(createRes.status).toBe(201)
    const createBody = (await createRes.json()) as { data: { conversation: { conversationId: string } } }
    const conversationId = createBody.data.conversation.conversationId

    const listRes = await app.request(`/conversations?contextId=${contextId}`)
    const listBody = (await listRes.json()) as { data: { conversations: { conversationId: string }[] } }
    expect(listBody.data.conversations.map((c) => c.conversationId)).toContain(conversationId)

    const messageRes = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'What have we decided so far?' }),
    })
    expect(messageRes.status).toBe(201)

    expect(mockSqsSend).toHaveBeenCalledOnce()
    const job = JSON.parse(mockSqsSend.mock.calls[0]?.[0].MessageBody)
    expect(job).toMatchObject({ conversationId, contextId, orgId, userId, tier: 'paid' })

    const messagesRes = await app.request(`/conversations/${conversationId}/messages`)
    const messagesBody = (await messagesRes.json()) as { data: { messages: { role: string; content: string }[] } }
    expect(messagesBody.data.messages).toHaveLength(1)
    expect(messagesBody.data.messages[0]).toMatchObject({ role: 'user', content: 'What have we decided so far?' })
  })

  it('rejects starting a conversation on a personal context owned by someone else', async () => {
    const orgId = await seedTestOrg()
    const ownerApp = makeApp(orgId, randomUUID())
    const { contextId } = await createContext(ownerApp, { name: 'Private notes', domain: 'personal' })

    const otherUserId = await seedUser(tables, { orgId }).write()
    const otherApp = makeApp(orgId, otherUserId, 'member')

    const res = await otherApp.request(`/conversations?contextId=${contextId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Snooping' }),
    })
    expect(res.status).toBe(404)
    expect(mockSqsSend).not.toHaveBeenCalled()
  })

  it('rejects posting a message once the caller no longer has access to the parent context', async () => {
    const ownerOrgId = await seedTestOrg()
    const ownerApp = makeApp(ownerOrgId, randomUUID())
    const { contextId } = await createContext(ownerApp, { name: 'Shared', domain: 'work', visibility: 'org' })

    const createRes = await ownerApp.request(`/conversations?contextId=${contextId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Thread' }),
    })
    const { data } = (await createRes.json()) as { data: { conversation: { conversationId: string } } }

    const otherOrgId = await seedTestOrg()
    const outsiderApp = makeApp(otherOrgId, randomUUID(), 'member')
    const res = await outsiderApp.request(`/conversations/${data.conversation.conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    })
    expect(res.status).toBe(404)
    expect(mockSqsSend).not.toHaveBeenCalled()
  })
})
