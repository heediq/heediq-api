import type { DynamoDBStreamHandler } from 'aws-lambda'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import { buildWsEvent, JobStatusSchema, createLogger } from '@heediq/shared'
import { pushToOrg } from '../lib/wsPush.js'

const logger = createLogger('heediq-api')

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
  }
}
