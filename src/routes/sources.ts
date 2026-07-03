import { Hono } from 'hono'
import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'
import { dynamo } from '../lib/dynamo.js'
import { apiError, ok } from '../lib/errors.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import {
  SourceSchema,
  JobSchema,
  SummarySchema,
  CreateSourceRequestSchema,
  UpdateSourceRequestSchema,
  EnqueueJobRequestSchema,
  PresignUploadRequestSchema,
  type Source,
  type TranscriptionJobMessage,
} from '@heediq/shared'

const sqs = new SQSClient({})
const s3 = new S3Client({})

const sources = new Hono<AuthContext>()

// GET /api/v1/sources — list org sources, cursor-paginated
sources.get('/', async (c) => {
  const orgId = c.get('orgId')
  const userId = c.get('userId')
  const role = c.get('role')
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
  const cursor = c.req.query('cursor')

  const result = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.sourcesTable,
    IndexName: 'by-org',
    KeyConditionExpression: 'orgId = :orgId',
    ExpressionAttributeValues: {
      ':orgId': orgId,
      ...(role === 'member' && { ':userId': userId }),
    },
    FilterExpression: role === 'member' ? 'userId = :userId' : undefined,
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
sources.post('/', async (c) => {
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
  return ok(c, { source }, 201)
})

// GET /api/v1/sources/:id
sources.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const res = await dynamo.send(new GetCommand({
    TableName: config.dynamo.sourcesTable,
    Key: { sourceId: id },
  }))
  if (!res.Item || res.Item['orgId'] !== orgId) {
    return apiError(c, 'NOT_FOUND', 'Source not found')
  }
  return ok(c, { source: SourceSchema.parse(res.Item) })
})

// PATCH /api/v1/sources/:id
sources.patch('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const body = await c.req.json()
  const parsed = UpdateSourceRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const now = new Date().toISOString()
  const res = await dynamo.send(new UpdateCommand({
    TableName: config.dynamo.sourcesTable,
    Key: { sourceId: id },
    ConditionExpression: 'orgId = :orgId',
    UpdateExpression: 'SET #title = :title, updatedAt = :now',
    ExpressionAttributeNames: { '#title': 'title' },
    ExpressionAttributeValues: { ':orgId': orgId, ':title': parsed.data.title, ':now': now },
    ReturnValues: 'ALL_NEW',
  }))

  return ok(c, { source: SourceSchema.parse(res.Attributes) })
})

// DELETE /api/v1/sources/:id — soft-delete (marks deletedAt, sets status=failed)
sources.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const now = new Date().toISOString()
  await dynamo.send(new UpdateCommand({
    TableName: config.dynamo.sourcesTable,
    Key: { sourceId: id },
    ConditionExpression: 'orgId = :orgId',
    UpdateExpression: 'SET #status = :status, deletedAt = :now, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':orgId': orgId, ':status': 'failed', ':now': now },
  }))
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
    dynamo.send(new GetCommand({ TableName: config.dynamo.sourcesTable, Key: { sourceId: id } })),
    dynamo.send(new GetCommand({ TableName: config.dynamo.orgsTable, Key: { orgId } })),
  ])

  if (!srcRes.Item || srcRes.Item['orgId'] !== orgId) {
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

  return ok(c, { job: JobSchema.parse(jobItem) }, 201)
})

// GET /api/v1/sources/:id/summary
sources.get('/:id/summary', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const res = await dynamo.send(new GetCommand({
    TableName: config.dynamo.sourcesTable,
    Key: { sourceId: id },
  }))
  if (!res.Item || res.Item['orgId'] !== orgId) {
    return apiError(c, 'NOT_FOUND', 'Source not found')
  }
  if (!res.Item['summary']) {
    return apiError(c, 'NOT_FOUND', 'Summary not yet available')
  }
  return ok(c, { summary: SummarySchema.parse(res.Item['summary']) })
})

export { sources as sourcesRouter }
