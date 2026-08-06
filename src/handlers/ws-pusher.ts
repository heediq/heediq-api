import type { DynamoDBStreamHandler } from 'aws-lambda'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { buildWsEvent, JobStatusSchema, createLogger, type JobStatus } from '@heediq/shared'
import { pushToOrg } from '../lib/wsPush.js'
import { dynamo } from '../lib/dynamo.js'
import { emitServerAnalytics } from '../lib/analytics.js'

const logger = createLogger('heediq-api')

// Optional here (only the analytics emit needs it) — resolved lazily so the pusher's core job of
// pushing WS status is unaffected if it's unset.
const SOURCES_TABLE = process.env['SOURCES_TABLE_NAME']

// Terminal job statuses that map to a server `source_processing_completed` analytics event — the
// authoritative async outcome the browser can't emit (D-154). Non-terminal transitions
// (transcribing, diarizing, …) are UI-progress only and don't emit.
const TERMINAL_STATUS: Partial<Record<JobStatus, 'done' | 'failed'>> = {
  done: 'done',
  failed: 'failed',
}

// Triggered by MODIFY events on heediq-jobs (D-061, generalized D-109) — the DDB Streams
// mechanism is unchanged from the original job-status design; only the push itself now goes
// through the shared wsPush/buildWsEvent library instead of a bespoke message shape. Pushed at
// org scope, not per-uploader, so every connected user in the org sees library-wide status.
export const handler: DynamoDBStreamHandler = async (event) => {
  for (const record of event.Records) {
    if (record.eventName !== 'MODIFY' || !record.dynamodb?.NewImage) continue

    const job = unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>)
    const { jobId, sourceId, orgId } = job
    const statusResult = JobStatusSchema.safeParse(job['status'])

    if (typeof jobId !== 'string' || typeof sourceId !== 'string' || typeof orgId !== 'string' || !statusResult.success) {
      logger.warn('Skipping job stream record with unexpected shape', { eventId: record.eventID })
      continue
    }

    const envelope = buildWsEvent({
      scope: { kind: 'org', orgId },
      type: 'job_status',
      payload: { jobId, sourceId, status: statusResult.data },
    })

    try {
      await pushToOrg(orgId, envelope)
    } catch (err: unknown) {
      logger.error('Failed to push job_status event', {
        jobId,
        orgId,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    // On a terminal transition, emit the server-side `source_processing_completed` (D-154). The
    // job record carries jobId + status but not the uploader; the source record carries userId but
    // not jobId — so this is the one place that has both after a single {orgId, sourceId} lookup.
    // Fully fail-safe: a lookup or emit failure only skips analytics, never the WS push (already
    // done above) and never re-raises. Deterministic insertId keeps DDB-stream retries idempotent.
    const terminalStatus = TERMINAL_STATUS[statusResult.data]
    if (terminalStatus && SOURCES_TABLE) {
      try {
        const source = await dynamo.send(
          new GetCommand({ TableName: SOURCES_TABLE, Key: { orgId, sourceId } }),
        )
        const userId = source.Item?.['userId']
        if (typeof userId === 'string') {
          await emitServerAnalytics({
            identity: { userId, orgId },
            type: 'source_processing_completed',
            payload: { sourceId, jobId, status: terminalStatus },
          })
        }
      } catch (err: unknown) {
        logger.error('Failed to emit source_processing_completed analytics', {
          jobId,
          sourceId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
}
