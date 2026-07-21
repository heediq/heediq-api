import { Hono } from 'hono'
import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'
import { dynamo } from '../lib/dynamo.js'
import { apiError, ok } from '../lib/errors.js'
import { auditWriter } from '../lib/audit.js'
import { requirePermission } from '../middleware/rbac.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import type { RequestIdContext } from '../middleware/request-id.js'
import { canAccessContext } from './contexts.js'
import {
  SourceSchema,
  JobSchema,
  SummarySchema,
  ContextSchema,
  ExtractedItemSchema,
  CreateSourceRequestSchema,
  UpdateSourceRequestSchema,
  EnqueueJobRequestSchema,
  PresignUploadRequestSchema,
  ReviewApprovalRequestSchema,
  createLogger,
  type Source,
  type TranscriptionJobMessage,
} from '@heediq/shared'

const sqs = new SQSClient({})
const s3 = new S3Client({})
const logger = createLogger('heediq-api')

type SourcesContext = AuthContext & RequestIdContext

const sources = new Hono<SourcesContext>()

function isAwsError(err: unknown): err is { name: string } {
  return typeof err === 'object' && err !== null && 'name' in err
}

// Audit entries are human-readable and self-contained (D-102), so a source mutation needs the
// owner's email even though the actor (who may have org-wide sources:update/delete) can differ
// from the source's userId — resolved via the users table rather than assumed to be the caller.
// Falls back to a synthetic but valid-format address (never the literal 'unknown') for an owner
// row that's missing (e.g. a deleted account) — @heediq/shared's audit payload requires
// z.string().email(), so an invalid fallback would 500 the mutation instead of just the audit note.
async function resolveOwnerEmail(userId: string): Promise<string> {
  const res = await dynamo.send(new GetCommand({ TableName: config.dynamo.usersTable, Key: { userId } }))
  return (res.Item?.['email'] as string) ?? `unknown-user+${userId}@heediq.internal`
}

// GET /api/v1/sources — list org sources, cursor-paginated
sources.get('/', async (c) => {
  const orgId = c.get('orgId')
  const userId = c.get('userId')
  // D-102 Phase 4: scoped to the caller's own sources whenever they lack org-wide read —
  // follows the actual granted permission rather than a hardcoded role name, so a custom role
  // built without sources:read also gets scoped correctly (not just the built-in `member` role).
  const ownSourcesOnly = !c.get('permissions').includes('sources:read')
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
  const cursor = c.req.query('cursor')

  const result = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.sourcesTable,
    IndexName: 'by-org-created',
    KeyConditionExpression: 'orgId = :orgId',
    ExpressionAttributeValues: {
      ':orgId': orgId,
      ...(ownSourcesOnly && { ':userId': userId }),
    },
    FilterExpression: ownSourcesOnly ? 'userId = :userId' : undefined,
    Limit: limit + 1,
    ExclusiveStartKey: cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()) : undefined,
    ScanIndexForward: false,
  }))

  const allItems = result.Items ?? []
  const hasMore = allItems.length > limit
  const items = allItems.slice(0, limit).map((i) => SourceSchema.parse(i))
  const nextCursor = hasMore && result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url')
    : null

  return ok(c, { sources: items, nextCursor })
})

// POST /api/v1/sources — create source
sources.post('/', requirePermission('sources:create'), async (c) => {
  const orgId = c.get('orgId')
  const userId = c.get('userId')
  const body = await c.req.json()
  const parsed = CreateSourceRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const now = new Date().toISOString()
  const source: Source = {
    sourceId: randomUUID(),
    orgId,
    userId,
    title: parsed.data.title,
    status: 'uploading',
    ...(parsed.data.durationSecs !== undefined && { durationSecs: parsed.data.durationSecs }),
    labels: [],
    createdAt: now,
    updatedAt: now,
  }

  await dynamo.send(new PutCommand({ TableName: config.dynamo.sourcesTable, Item: source }))
  logger.info('Source created', { requestId: c.get('requestId'), sourceId: source.sourceId, orgId })
  await auditWriter(c)({
    resourceType: 'source',
    action: 'source:create',
    after: { sourceId: source.sourceId, title: source.title, ownerEmail: c.get('email') },
  })
  return ok(c, { source }, 201)
})

// GET /api/v1/sources/:id
sources.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const res = await dynamo.send(new GetCommand({
    TableName: config.dynamo.sourcesTable,
    Key: { orgId, sourceId: id },
  }))
  if (!res.Item) {
    return apiError(c, 'NOT_FOUND', 'Source not found')
  }
  return ok(c, { source: SourceSchema.parse(res.Item) })
})

// PATCH /api/v1/sources/:id
sources.patch('/:id', requirePermission('sources:update'), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const body = await c.req.json()
  const parsed = UpdateSourceRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const existingRes = await dynamo.send(new GetCommand({
    TableName: config.dynamo.sourcesTable,
    Key: { orgId, sourceId: id },
  }))
  if (!existingRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Source not found')
  }
  const before = SourceSchema.parse(existingRes.Item)

  const now = new Date().toISOString()
  let res
  try {
    res = await dynamo.send(new UpdateCommand({
      TableName: config.dynamo.sourcesTable,
      Key: { orgId, sourceId: id },
      ConditionExpression: 'attribute_exists(sourceId)',
      UpdateExpression: 'SET #title = :title, updatedAt = :now',
      ExpressionAttributeNames: { '#title': 'title' },
      ExpressionAttributeValues: { ':title': parsed.data.title, ':now': now },
      ReturnValues: 'ALL_NEW',
    }))
  } catch (err: unknown) {
    if (isAwsError(err) && err.name === 'ConditionalCheckFailedException') {
      return apiError(c, 'NOT_FOUND', 'Source not found')
    }
    throw err
  }

  logger.info('Source updated', { requestId: c.get('requestId'), sourceId: id, orgId })
  const after = SourceSchema.parse(res.Attributes)
  const ownerEmail = await resolveOwnerEmail(after.userId)
  await auditWriter(c)({
    resourceType: 'source',
    action: 'source:update',
    before: { sourceId: before.sourceId, title: before.title, ownerEmail },
    after: { sourceId: after.sourceId, title: after.title, ownerEmail },
  })
  return ok(c, { source: after })
})

// DELETE /api/v1/sources/:id — soft-delete (marks deletedAt, sets status=failed)
sources.delete('/:id', requirePermission('sources:delete'), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')

  const existingRes = await dynamo.send(new GetCommand({
    TableName: config.dynamo.sourcesTable,
    Key: { orgId, sourceId: id },
  }))
  if (!existingRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Source not found')
  }
  const before = SourceSchema.parse(existingRes.Item)

  const now = new Date().toISOString()
  try {
    await dynamo.send(new UpdateCommand({
      TableName: config.dynamo.sourcesTable,
      Key: { orgId, sourceId: id },
      ConditionExpression: 'attribute_exists(sourceId)',
      UpdateExpression: 'SET #status = :status, deletedAt = :now, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': 'failed', ':now': now },
    }))
  } catch (err: unknown) {
    if (isAwsError(err) && err.name === 'ConditionalCheckFailedException') {
      return apiError(c, 'NOT_FOUND', 'Source not found')
    }
    throw err
  }
  logger.info('Source soft-deleted', { requestId: c.get('requestId'), sourceId: id, orgId })
  const ownerEmail = await resolveOwnerEmail(before.userId)
  await auditWriter(c)({
    resourceType: 'source',
    action: 'source:delete',
    before: { sourceId: before.sourceId, title: before.title, ownerEmail },
  })
  return ok(c, { deleted: true })
})

// POST /api/v1/sources/:id/jobs — enqueue transcription job (D-060 access control)
sources.post('/:id/jobs', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const body = await c.req.json()
  const parsed = EnqueueJobRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  // D-060: fetch org plan and enforce model access before enqueue
  const [srcRes, orgRes] = await Promise.all([
    dynamo.send(new GetCommand({ TableName: config.dynamo.sourcesTable, Key: { orgId, sourceId: id } })),
    dynamo.send(new GetCommand({ TableName: config.dynamo.orgsTable, Key: { orgId } })),
  ])

  if (!srcRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Source not found')
  }
  if (!srcRes.Item['audioS3Key']) {
    return apiError(c, 'BAD_REQUEST', 'Source has no audio uploaded yet')
  }

  const tier = (orgRes.Item?.['plan'] ?? 'free') as 'free' | 'paid'
  if (parsed.data.model === 'large-v3' && tier !== 'paid') {
    return apiError(c, 'FORBIDDEN', 'large-v3 model requires a paid plan')
  }

  const jobId = randomUUID()
  const now = new Date().toISOString()

  const jobItem = {
    jobId,
    sourceId: id,
    orgId,
    status: 'queued' as const,
    model: parsed.data.model,
    tier,
    createdAt: now,
  }
  await dynamo.send(new PutCommand({ TableName: config.dynamo.jobsTable, Item: jobItem }))

  const message: TranscriptionJobMessage = {
    jobId,
    sourceId: id,
    orgId,
    audioS3Key: srcRes.Item['audioS3Key'] as string,
    model: parsed.data.model,
    tier,
  }
  await sqs.send(new SendMessageCommand({
    QueueUrl: config.sqs.transcriptionQueueUrl,
    MessageBody: JSON.stringify(message),
    // EventBridge Pipes (heediq-infra TranscriptionStack) routes free/paid tasks by filtering
    // on this attribute — without it, neither pipe's filterCriteria matches and the job is
    // never picked up.
    MessageAttributes: {
      tier: { DataType: 'String', StringValue: tier },
    },
  }))

  logger.info('Transcription job enqueued', {
    requestId: c.get('requestId'),
    sourceId: id,
    jobId,
    tier,
    model: parsed.data.model,
  })
  return ok(c, { job: JobSchema.parse(jobItem) }, 201)
})

// GET /api/v1/sources/:id/summary
sources.get('/:id/summary', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const res = await dynamo.send(new GetCommand({
    TableName: config.dynamo.sourcesTable,
    Key: { orgId, sourceId: id },
  }))
  if (!res.Item) {
    return apiError(c, 'NOT_FOUND', 'Source not found')
  }
  if (!res.Item['summary']) {
    return apiError(c, 'NOT_FOUND', 'Summary not yet available')
  }
  return ok(c, { summary: SummarySchema.parse(res.Item['summary']) })
})

// POST /api/v1/sources/:id/review — files a Source's kept ExtractedItems into a Context (D-137
// wizard steps 1-2). Non-kept items are marked `discarded`, not deleted — full item history stays
// queryable for chat/ledger generation later (D-136 reads across a Context's item history, not
// just the kept subset).
sources.post('/:id/review', requirePermission('sources:update'), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const body = await c.req.json()
  const parsed = ReviewApprovalRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const sourceRes = await dynamo.send(new GetCommand({
    TableName: config.dynamo.sourcesTable,
    Key: { orgId, sourceId: id },
  }))
  if (!sourceRes.Item) {
    return apiError(c, 'NOT_FOUND', 'Source not found')
  }

  const contextRes = await dynamo.send(new GetCommand({
    TableName: config.dynamo.contextsTable,
    Key: { contextId: parsed.data.contextId },
  }))
  if (!contextRes.Item || !(await canAccessContext(c, ContextSchema.parse(contextRes.Item)))) {
    return apiError(c, 'BAD_REQUEST', 'Context not found or not visible to you')
  }

  const itemsRes = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.extractedItemsTable,
    KeyConditionExpression: 'sourceId = :sourceId',
    ExpressionAttributeValues: { ':sourceId': id },
  }))
  const items = (itemsRes.Items ?? []).map((i) => ExtractedItemSchema.parse(i))
  const keptIds = new Set(parsed.data.kept)

  const now = new Date().toISOString()
  await Promise.all(items.map((item) => {
    const kept = keptIds.has(item.itemId)
    return dynamo.send(new UpdateCommand({
      TableName: config.dynamo.extractedItemsTable,
      Key: { sourceId: item.sourceId, itemId: item.itemId },
      UpdateExpression: kept
        ? 'SET #status = :status, contextId = :contextId'
        : 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: kept
        ? { ':status': 'kept', ':contextId': parsed.data.contextId }
        : { ':status': 'discarded' },
    }))
  }))

  await dynamo.send(new UpdateCommand({
    TableName: config.dynamo.sourcesTable,
    Key: { orgId, sourceId: id },
    ConditionExpression: 'attribute_exists(sourceId)',
    UpdateExpression: 'SET classification = :classification, updatedAt = :now',
    ExpressionAttributeValues: { ':classification': 'approved', ':now': now },
  }))

  const keptCount = items.filter((i) => keptIds.has(i.itemId)).length
  const discardedCount = items.length - keptCount
  logger.info('Source review approved', {
    requestId: c.get('requestId'),
    sourceId: id,
    contextId: parsed.data.contextId,
    keptCount,
    discardedCount,
  })
  await auditWriter(c)({
    resourceType: 'extractedItemReview',
    action: 'source:review',
    after: { sourceId: id, contextId: parsed.data.contextId, keptCount, discardedCount },
  })
  return ok(c, { keptCount, discardedCount })
})

export { sources as sourcesRouter }
