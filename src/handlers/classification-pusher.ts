import type { DynamoDBStreamHandler } from 'aws-lambda'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import { buildWsEvent, createLogger, type WsEventPayloadMap } from '@heediq/shared'
import { pushToOrg } from '../lib/wsPush.js'

const logger = createLogger('heediq-api')

// Triggered by MODIFY events on heediq-sources whose `classification` just became `pending_review`
// (the event-source filter narrows to that transition — D-133). Mirrors the job_status pusher: the
// ingest worker (heediq-worker-summarization) writes the review-gate state to DynamoDB, and this
// stream handler fans the classifier's proposal out as a `classification_ready` WS event at org
// scope so the review card renders live without polling (D-109/D-130/D-133). Workers never push WS
// themselves — the push always lives here in heediq-api next to the wsPush library.
export const handler: DynamoDBStreamHandler = async (event) => {
  for (const record of event.Records) {
    if (record.eventName !== 'MODIFY' || !record.dynamodb?.NewImage) continue

    const source = unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>)

    // Defensive re-check (the stream filter should already guarantee this) — only emit for a Source
    // sitting at the review gate with a proposal to show.
    if (source['classification'] !== 'pending_review') continue

    const { sourceId, orgId, proposedClassification } = source
    if (
      typeof sourceId !== 'string' ||
      typeof orgId !== 'string' ||
      proposedClassification === null ||
      typeof proposedClassification !== 'object'
    ) {
      logger.warn('Skipping source stream record with unexpected shape', { eventId: record.eventID })
      continue
    }

    // The payload is the persisted proposal plus the sourceId. buildWsEvent validates it against the
    // classification_ready schema; a malformed proposal is logged and skipped (not retried forever).
    let envelope
    try {
      const payload = {
        ...(proposedClassification as Record<string, unknown>),
        sourceId,
      } as WsEventPayloadMap['classification_ready']
      envelope = buildWsEvent({ scope: { kind: 'org', orgId }, type: 'classification_ready', payload })
    } catch (err: unknown) {
      logger.warn('Skipping source with invalid proposedClassification', {
        sourceId,
        orgId,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    try {
      await pushToOrg(orgId, envelope)
    } catch (err: unknown) {
      logger.error('Failed to push classification_ready event', {
        sourceId,
        orgId,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }
}
