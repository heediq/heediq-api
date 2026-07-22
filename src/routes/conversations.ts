import { Hono } from 'hono'
import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { randomUUID } from 'crypto'
import { dynamo } from '../lib/dynamo.js'
import { auditWriter } from '../lib/audit.js'
import { apiError, ok } from '../lib/errors.js'
import { requirePermission } from '../middleware/rbac.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import type { RequestIdContext } from '../middleware/request-id.js'
import { canAccessContext } from './contexts.js'
import {
  ContextSchema,
  ConversationSchema,
  ChatMessageSchema,
  CreateConversationRequestSchema,
  CreateMessageRequestSchema,
  createLogger,
  type ChatJobMessage,
} from '@heediq/shared'

const sqs = new SQSClient({})
const logger = createLogger('heediq-api')

type ConversationsContext = AuthContext & RequestIdContext

const conversations = new Hono<ConversationsContext>()

// Both routes below fetch the parent Context to run `canAccessContext` (D-141/D-142) rather than
// trusting the caller's own org/userId — a Context can be personal/group/org scoped, and a
// cross-org grant (D-142) is the only case where the caller isn't in the owner's org at all.
async function loadContext(contextId: string) {
  const res = await dynamo.send(new GetCommand({ TableName: config.dynamo.contextsTable, Key: { contextId } }))
  return res.Item ? ContextSchema.parse(res.Item) : undefined
}

async function loadConversation(conversationId: string) {
  const res = await dynamo.send(new GetCommand({ TableName: config.dynamo.conversationsTable, Key: { conversationId } }))
  return res.Item ? ConversationSchema.parse(res.Item) : undefined
}

// Tier drives which Claude model heediq-chat uses (D-067) — same org-plan lookup sources.ts
// uses for transcription jobs, not a per-conversation setting.
async function resolveTier(orgId: string): Promise<'free' | 'paid'> {
  const res = await dynamo.send(new GetCommand({ TableName: config.dynamo.orgsTable, Key: { orgId } }))
  return (res.Item?.['plan'] ?? 'free') as 'free' | 'paid'
}

// POST /api/v1/conversations?contextId=... — start a new chat thread on a Context. Starting a
// conversation is treated as a `contribute`-tier use of the Context (it will drive Claude turns
// against the Context's memory), not a mere read — so a `read`-only cross-org grant (D-142) can
// list/view a shared Context's threads but not start new ones.
conversations.post('/', requirePermission('context:read'), async (c) => {
  const orgId = c.get('orgId')
  const userId = c.get('userId')
  const contextId = c.req.query('contextId')
  if (!contextId) {
    return apiError(c, 'BAD_REQUEST', 'Missing contextId query parameter')
  }
  const body = await c.req.json()
  const parsed = CreateConversationRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const context = await loadContext(contextId)
  if (!context || !(await canAccessContext(c, context, 'contribute'))) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }

  const conversationId = randomUUID()
  const now = new Date().toISOString()
  const conversation = ConversationSchema.parse({
    conversationId,
    contextId,
    orgId,
    userId,
    title: parsed.data.title,
    createdAt: now,
    updatedAt: now,
  })
  await dynamo.send(new PutCommand({ TableName: config.dynamo.conversationsTable, Item: conversation }))

  logger.info('Conversation created', { requestId: c.get('requestId'), conversationId, contextId })
  await auditWriter(c)({
    resourceType: 'conversation',
    action: 'conversation:create',
    after: { conversationId, contextId, title: conversation.title },
  })
  return ok(c, { conversation }, 201)
})

// GET /api/v1/conversations?contextId=... — a Context's threads, most-recently-active first
// (`by-context` GSI, D-138).
conversations.get('/', requirePermission('context:read'), async (c) => {
  const contextId = c.req.query('contextId')
  if (!contextId) {
    return apiError(c, 'BAD_REQUEST', 'Missing contextId query parameter')
  }
  const context = await loadContext(contextId)
  if (!context || !(await canAccessContext(c, context, 'read'))) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }

  const res = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.conversationsTable,
    IndexName: 'by-context',
    KeyConditionExpression: 'contextId = :contextId',
    ExpressionAttributeValues: { ':contextId': contextId },
    ScanIndexForward: false,
  }))
  const items = (res.Items ?? []).map((i) => ConversationSchema.parse(i))
  return ok(c, { conversations: items })
})

// GET /api/v1/conversations/:id/messages — full turn history, chronological.
conversations.get('/:id/messages', requirePermission('context:read'), async (c) => {
  const conversationId = c.req.param('id')
  const conversation = await loadConversation(conversationId)
  if (!conversation) {
    return apiError(c, 'NOT_FOUND', 'Conversation not found')
  }
  const context = await loadContext(conversation.contextId)
  if (!context || !(await canAccessContext(c, context, 'read'))) {
    return apiError(c, 'NOT_FOUND', 'Conversation not found')
  }

  const res = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.chatMessagesTable,
    KeyConditionExpression: 'conversationId = :conversationId',
    ExpressionAttributeValues: { ':conversationId': conversationId },
    ScanIndexForward: true,
  }))
  const items = (res.Items ?? []).map((i) => ChatMessageSchema.parse(i))
  return ok(c, { messages: items })
})

// POST /api/v1/conversations/:id/messages — persist the user's turn and enqueue the chat job
// heediq-chat consumes (D-138/D-139). `contribute` access, same reasoning as conversation
// creation. Message content is included in the audit payload's *before/after* deliberately never
// — only ids/role (D-093) — the ChatMessageAuditPayloadSchema in `@heediq/shared` already
// enforces this shape.
conversations.post('/:id/messages', requirePermission('context:read'), async (c) => {
  const orgId = c.get('orgId')
  const userId = c.get('userId')
  const conversationId = c.req.param('id')
  const body = await c.req.json()
  const parsed = CreateMessageRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const conversation = await loadConversation(conversationId)
  if (!conversation) {
    return apiError(c, 'NOT_FOUND', 'Conversation not found')
  }
  const context = await loadContext(conversation.contextId)
  if (!context || !(await canAccessContext(c, context, 'contribute'))) {
    return apiError(c, 'NOT_FOUND', 'Conversation not found')
  }

  const messageId = randomUUID()
  const now = new Date().toISOString()
  const sk = `${now}#${messageId}`
  const message = ChatMessageSchema.parse({
    conversationId,
    sk,
    messageId,
    role: 'user' as const,
    content: parsed.data.content,
    createdAt: now,
  })
  await dynamo.send(new PutCommand({ TableName: config.dynamo.chatMessagesTable, Item: message }))
  await dynamo.send(new UpdateCommand({
    TableName: config.dynamo.conversationsTable,
    Key: { conversationId },
    UpdateExpression: 'SET updatedAt = :now',
    ExpressionAttributeValues: { ':now': now },
  }))

  const tier = await resolveTier(orgId)
  const jobMessage: ChatJobMessage = {
    jobId: randomUUID(),
    conversationId,
    contextId: conversation.contextId,
    orgId,
    userId,
    userMessageId: messageId,
    tier,
  }
  await sqs.send(new SendMessageCommand({
    QueueUrl: config.sqs.chatQueueUrl,
    MessageBody: JSON.stringify(jobMessage),
  }))

  logger.info('Chat message persisted and job enqueued', {
    requestId: c.get('requestId'),
    conversationId,
    messageId,
    jobId: jobMessage.jobId,
    tier,
  })
  await auditWriter(c)({
    resourceType: 'chatMessage',
    action: 'chatMessage:create',
    after: { conversationId, messageId, role: 'user' },
  })
  return ok(c, { message }, 201)
})

export { conversations as conversationsRouter }
