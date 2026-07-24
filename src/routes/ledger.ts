import { Hono } from 'hono'
import { GetCommand, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'crypto'
import { dynamo } from '../lib/dynamo.js'
import { auditWriter } from '../lib/audit.js'
import { apiError, ok } from '../lib/errors.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import type { RequestIdContext } from '../middleware/request-id.js'
import {
  ContextSchema,
  DecisionLedgerEntrySchema,
  CreateLedgerEntryRequestSchema,
  UpdateLedgerEntryRequestSchema,
  createLogger,
  type DecisionLedgerEntry,
  type LedgerEntryStatus,
} from '@heediq/shared'
import { canAccessContext } from './contexts.js'

const logger = createLogger('heediq-api')

type LedgerContext = AuthContext & RequestIdContext

// A Context's Decision Ledger (D-136/D-148). Mounted on `/contexts` alongside `contextsRouter`, so
// paths are `/contexts/:id/ledger[/:entryId]`. The heediq-ledger worker owns the auto-write path
// (review-time reconciliation); these routes are the human read/fill surface — reads settle the
// ledger, and the D-149 chat gate (in conversations.ts) blocks chat until it's settled.
const ledger = new Hono<LedgerContext>()

// A user-authored answer is trusted: confidence is server-set to 1.0 and never client-supplied
// (D-148), so status is driven purely by whether there is an answer. An explicit `status` on PATCH
// (confirm a `needs_review` / reopen) wins over this default.
function statusForUserAnswer(answer: string | null): LedgerEntryStatus {
  return answer === null ? 'open' : 'confirmed'
}

// Loads the parent Context for the access check (D-141/D-142) — the ledger table is PK=contextId
// with no orgId, so isolation rides on the Context's own visibility/grant gate, never the raw
// contextId path param.
async function loadContext(contextId: string) {
  const res = await dynamo.send(new GetCommand({
    TableName: config.dynamo.contextsTable,
    Key: { contextId },
  }))
  return res.Item ? ContextSchema.parse(res.Item) : undefined
}

async function loadEntry(contextId: string, entryId: string): Promise<DecisionLedgerEntry | undefined> {
  const res = await dynamo.send(new GetCommand({
    TableName: config.dynamo.decisionLedgerTable,
    Key: { contextId, entryId },
  }))
  return res.Item ? DecisionLedgerEntrySchema.parse(res.Item) : undefined
}

// GET /api/v1/contexts/:id/ledger — the Context's full ledger (all statuses). Reading is a `read`
// use, so a cross-org `read` grant (D-142) can view it; PK=contextId returns every entry.
ledger.get('/:id/ledger', requirePermission('context:read'), async (c) => {
  const contextId = c.req.param('id')
  const context = await loadContext(contextId)
  if (!context || !(await canAccessContext(c, context, 'read'))) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }

  const entries: DecisionLedgerEntry[] = []
  let lastKey: Record<string, unknown> | undefined
  do {
    const res = await dynamo.send(new QueryCommand({
      TableName: config.dynamo.decisionLedgerTable,
      KeyConditionExpression: 'contextId = :cid',
      ExpressionAttributeValues: { ':cid': contextId },
      ExclusiveStartKey: lastKey,
    }))
    for (const item of res.Items ?? []) entries.push(DecisionLedgerEntrySchema.parse(item))
    lastKey = res.LastEvaluatedKey
  } while (lastKey)

  return ok(c, { entries })
})

// POST /api/v1/contexts/:id/ledger — manually add a decision/question the user wants tracked
// (D-148, wizard step 3 / standalone). Mutations reuse `context:update` + `contribute` (D-149).
ledger.post('/:id/ledger', requirePermission('context:update'), async (c) => {
  const contextId = c.req.param('id')
  const body = await c.req.json()
  const parsed = CreateLedgerEntryRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const context = await loadContext(contextId)
  if (!context || !(await canAccessContext(c, context, 'contribute'))) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }

  const answer = parsed.data.answer ?? null
  const now = new Date().toISOString()
  const entry = DecisionLedgerEntrySchema.parse({
    entryId: randomUUID(),
    contextId,
    topic: parsed.data.topic,
    answer,
    status: statusForUserAnswer(answer),
    confidence: 1.0,
    origin: 'user',
    sourceRefs: [],
    createdAt: now,
    updatedAt: now,
  })
  await dynamo.send(new PutCommand({ TableName: config.dynamo.decisionLedgerTable, Item: entry }))

  logger.info('Ledger entry created', { requestId: c.get('requestId'), contextId, entryId: entry.entryId })
  await auditWriter(c)({
    resourceType: 'ledgerEntry',
    action: 'ledgerEntry:create',
    after: { entryId: entry.entryId, contextId, status: entry.status, origin: entry.origin },
  })
  return ok(c, entry, 201)
})

// PATCH /api/v1/contexts/:id/ledger/:entryId — fill/confirm/edit an entry. A user edit always sets
// origin=user + confidence=1.0 (D-148). `answer: null` explicitly reopens; omitting it keeps the
// stored answer. An explicit `status` (confirm/reopen) wins over the answer-derived default.
ledger.patch('/:id/ledger/:entryId', requirePermission('context:update'), async (c) => {
  const contextId = c.req.param('id')
  const entryId = c.req.param('entryId')
  const body = await c.req.json()
  const parsed = UpdateLedgerEntryRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const context = await loadContext(contextId)
  if (!context || !(await canAccessContext(c, context, 'contribute'))) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }
  const existing = await loadEntry(contextId, entryId)
  if (!existing) {
    return apiError(c, 'NOT_FOUND', 'Ledger entry not found')
  }

  const answer = 'answer' in parsed.data ? (parsed.data.answer ?? null) : existing.answer
  const status = parsed.data.status ?? statusForUserAnswer(answer)
  const updated = DecisionLedgerEntrySchema.parse({
    ...existing,
    topic: parsed.data.topic ?? existing.topic,
    answer,
    status,
    confidence: 1.0,
    origin: 'user',
    updatedAt: new Date().toISOString(),
  })
  await dynamo.send(new PutCommand({ TableName: config.dynamo.decisionLedgerTable, Item: updated }))

  logger.info('Ledger entry updated', { requestId: c.get('requestId'), contextId, entryId })
  await auditWriter(c)({
    resourceType: 'ledgerEntry',
    action: 'ledgerEntry:update',
    before: { entryId, contextId, status: existing.status, origin: existing.origin },
    after: { entryId, contextId, status: updated.status, origin: updated.origin },
  })
  return ok(c, updated)
})

// DELETE /api/v1/contexts/:id/ledger/:entryId — remove an entry (the reconciliation worker never
// deletes; removal is an explicit user action, D-148). Reuses `context:update` (D-149).
ledger.delete('/:id/ledger/:entryId', requirePermission('context:update'), async (c) => {
  const contextId = c.req.param('id')
  const entryId = c.req.param('entryId')

  const context = await loadContext(contextId)
  if (!context || !(await canAccessContext(c, context, 'contribute'))) {
    return apiError(c, 'NOT_FOUND', 'Context not found')
  }
  const existing = await loadEntry(contextId, entryId)
  if (!existing) {
    return apiError(c, 'NOT_FOUND', 'Ledger entry not found')
  }

  await dynamo.send(new DeleteCommand({
    TableName: config.dynamo.decisionLedgerTable,
    Key: { contextId, entryId },
  }))

  logger.info('Ledger entry deleted', { requestId: c.get('requestId'), contextId, entryId })
  await auditWriter(c)({
    resourceType: 'ledgerEntry',
    action: 'ledgerEntry:delete',
    before: { entryId, contextId, status: existing.status, origin: existing.origin },
  })
  return ok(c, { entryId })
})

export { ledger as ledgerRouter }
