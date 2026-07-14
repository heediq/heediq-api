import type { Context } from 'hono'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { buildAuditLogEntry, createLogger, type AuditPayloadMap, type AuditResourceType, type OrgRole } from '@heediq/shared'
import { dynamo } from './dynamo.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'

const logger = createLogger('heediq-api')

export interface WriteAuditEventInput<T extends AuditResourceType> {
  orgId: string
  resourceType: T
  action: string
  actorUserId: string
  actorEmail: string
  actorRole: OrgRole
  before?: AuditPayloadMap[T]
  after?: AuditPayloadMap[T]
}

// pk=ORG#<orgId>, sk=<isoTimestamp>#<eventId> — write-once by construction; the audit-log
// table's IAM grant is write-only (no GetItem/Query/Scan), so this is the only path that can
// ever touch it. Never logs `before`/`after` payload bodies — ids and action only (D-093).
export async function writeAuditEvent<T extends AuditResourceType>(
  input: WriteAuditEventInput<T>,
): Promise<void> {
  const entry = buildAuditLogEntry(input)
  const pk = `ORG#${entry.orgId}`
  const sk = `${entry.timestamp}#${entry.eventId}`

  logger.info('Writing audit event', {
    orgId: entry.orgId,
    eventId: entry.eventId,
    resourceType: entry.resourceType,
    action: entry.action,
  })
  try {
    await dynamo.send(new PutCommand({
      TableName: config.dynamo.auditLogTable,
      Item: { pk, sk, ...entry },
    }))
  } catch (err: unknown) {
    logger.error('Failed to write audit event', {
      orgId: entry.orgId,
      eventId: entry.eventId,
      resourceType: entry.resourceType,
      action: entry.action,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

// Route handlers call `auditWriter(c)` instead of `writeAuditEvent` directly — pulls
// orgId/actorUserId/actorEmail/actorRole from the already-verified AuthContext (set by
// authMiddleware) so every call site only has to spell out what's actually resource-specific:
// resourceType/action/before/after. Keeps the human-readable, per-resource-type payload
// construction explicit at the route (D-102) while removing the actor/org boilerplate.
export function auditWriter<E extends AuthContext>(c: Context<E>) {
  return <T extends AuditResourceType>(
    input: Omit<WriteAuditEventInput<T>, 'orgId' | 'actorUserId' | 'actorEmail' | 'actorRole'>,
  ): Promise<void> =>
    writeAuditEvent({
      ...input,
      orgId: c.get('orgId'),
      actorUserId: c.get('userId'),
      actorEmail: c.get('email'),
      actorRole: c.get('role'),
    })
}
