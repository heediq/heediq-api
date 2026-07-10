import { Hono } from 'hono'
import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import { ok } from '../lib/errors.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import type { RequestIdContext } from '../middleware/request-id.js'
import { AuditLogEntrySchema, createLogger } from '@heediq/shared'

const logger = createLogger('heediq-api')

type AuditLogContext = AuthContext & RequestIdContext

export const auditLogRouter = new Hono<AuditLogContext>()

// GET /org/audit-log — cursor-paginated, filterable by date range/actor/action/resource type
// (D-102 Phase 5). Two query shapes: no actor filter queries the base table (pk=ORG#<orgId>);
// an actor filter queries the `by-user` GSI instead (partitioned on actorUserId, not orgId), so
// `orgId` is always re-asserted via FilterExpression there as cross-org isolation defense in
// depth (07-engineering-standards.md §2), even though a user belongs to exactly one org today.
auditLogRouter.get('/', requirePermission('audit:read'), async (c) => {
  const orgId = c.get('orgId')
  const requestId = c.get('requestId')
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
  const cursor = c.req.query('cursor')
  const actorUserId = c.req.query('actorUserId')
  const action = c.req.query('action')
  const resourceType = c.req.query('resourceType')
  const from = c.req.query('from')
  const to = c.req.query('to')

  logger.info('Listing audit log', { requestId, orgId, actorUserId, action, resourceType, from, to })

  const filterClauses: string[] = []
  const values: Record<string, string> = {}
  if (action) {
    filterClauses.push('action = :action')
    values[':action'] = action
  }
  if (resourceType) {
    filterClauses.push('resourceType = :resourceType')
    values[':resourceType'] = resourceType
  }

  let keyCondition: string
  let indexName: string | undefined
  if (actorUserId) {
    indexName = 'by-user'
    keyCondition = 'actorUserId = :actorUserId'
    values[':actorUserId'] = actorUserId
    filterClauses.push('orgId = :orgId')
    values[':orgId'] = orgId
  } else {
    keyCondition = 'pk = :pk'
    values[':pk'] = `ORG#${orgId}`
  }

  // sk = <isoTimestamp>#<eventId>; appending a high sentinel to `to` makes the upper bound
  // inclusive of every event at that exact millisecond, not just ones sorting before it.
  if (from && to) {
    keyCondition += ' AND sk BETWEEN :from AND :to'
    values[':from'] = from
    values[':to'] = `${to}￿`
  } else if (from) {
    keyCondition += ' AND sk >= :from'
    values[':from'] = from
  } else if (to) {
    keyCondition += ' AND sk <= :to'
    values[':to'] = `${to}￿`
  }

  const result = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.auditLogTable,
    IndexName: indexName,
    KeyConditionExpression: keyCondition,
    FilterExpression: filterClauses.length > 0 ? filterClauses.join(' AND ') : undefined,
    ExpressionAttributeValues: values,
    Limit: limit + 1,
    ExclusiveStartKey: cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()) : undefined,
    ScanIndexForward: false,
  }))

  const allItems = result.Items ?? []
  const hasMore = allItems.length > limit
  const entries = allItems.slice(0, limit).map((i) => AuditLogEntrySchema.parse(i))
  const nextCursor = hasMore && result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url')
    : null

  logger.info('Listed audit log', { requestId, orgId, resultCount: entries.length })
  return ok(c, { entries, nextCursor })
})
