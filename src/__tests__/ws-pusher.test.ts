import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DynamoDBStreamEvent } from 'aws-lambda'

process.env['SOURCES_TABLE_NAME'] = 'heediq-sources'

const mockPushToOrg = vi.hoisted(() => vi.fn())
const dynamoSend = vi.hoisted(() => vi.fn())
const emitServerAnalytics = vi.hoisted(() => vi.fn())

vi.mock('../lib/wsPush.js', () => ({ pushToOrg: mockPushToOrg }))
vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: (...args: unknown[]) => dynamoSend(...args) } }))
vi.mock('../lib/analytics.js', () => ({ emitServerAnalytics }))

const { handler } = await import('../handlers/ws-pusher.js')

const jobId = '00000000-0000-0000-0000-000000000001'
const sourceId = '00000000-0000-0000-0000-000000000002'
const orgId = '00000000-0000-0000-0000-000000000003'

function makeStreamEvent(overrides: {
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE'
  newImage?: Record<string, unknown>
}): DynamoDBStreamEvent {
  const newImage = overrides.newImage ?? {
    jobId: { S: jobId },
    sourceId: { S: sourceId },
    orgId: { S: orgId },
    status: { S: 'transcribing' },
  }
  return {
    Records: [
      {
        eventID: 'e1',
        eventName: overrides.eventName ?? 'MODIFY',
        dynamodb: {
          NewImage: newImage as never,
        },
      } as never,
    ],
  }
}

beforeEach(() => {
  mockPushToOrg.mockReset()
  dynamoSend.mockReset()
  emitServerAnalytics.mockReset()
})

function terminalEvent(status: 'done' | 'failed'): DynamoDBStreamEvent {
  return makeStreamEvent({
    newImage: {
      jobId: { S: jobId },
      sourceId: { S: sourceId },
      orgId: { S: orgId },
      status: { S: status },
    },
  })
}

describe('ws-pusher handler', () => {
  it('pushes a job_status event at org scope on MODIFY', async () => {
    mockPushToOrg.mockResolvedValueOnce(undefined)

    await handler(makeStreamEvent({}), {} as never, () => undefined)

    expect(mockPushToOrg).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({
        type: 'job_status',
        scope: { kind: 'org', orgId },
        payload: { jobId, sourceId, status: 'transcribing' },
      }),
    )
  })

  it('ignores INSERT and REMOVE events', async () => {
    await handler(makeStreamEvent({ eventName: 'INSERT' }), {} as never, () => undefined)
    await handler(makeStreamEvent({ eventName: 'REMOVE' }), {} as never, () => undefined)
    expect(mockPushToOrg).not.toHaveBeenCalled()
  })

  it('skips a record with an invalid status value without throwing', async () => {
    await handler(
      makeStreamEvent({
        newImage: {
          jobId: { S: jobId },
          sourceId: { S: sourceId },
          orgId: { S: orgId },
          status: { S: 'not-a-real-status' },
        },
      }),
      {} as never,
      () => undefined,
    )
    expect(mockPushToOrg).not.toHaveBeenCalled()
  })

  it('propagates errors from pushToOrg so DDB Streams retries the batch', async () => {
    mockPushToOrg.mockRejectedValueOnce(new Error('push failed'))
    await expect(handler(makeStreamEvent({}), {} as never, () => undefined)).rejects.toThrow('push failed')
  })

  it('emits source_processing_completed with the source uploader on a terminal done status', async () => {
    mockPushToOrg.mockResolvedValueOnce(undefined)
    dynamoSend.mockResolvedValueOnce({ Item: { orgId, sourceId, userId: 'uploader-1' } })

    await handler(terminalEvent('done'), {} as never, () => undefined)

    expect(emitServerAnalytics).toHaveBeenCalledWith({
      identity: { userId: 'uploader-1', orgId },
      type: 'source_processing_completed',
      payload: { sourceId, jobId, status: 'done' },
    })
  })

  it('carries the failed terminal status through to the event', async () => {
    mockPushToOrg.mockResolvedValueOnce(undefined)
    dynamoSend.mockResolvedValueOnce({ Item: { orgId, sourceId, userId: 'uploader-1' } })

    await handler(terminalEvent('failed'), {} as never, () => undefined)

    expect(emitServerAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { sourceId, jobId, status: 'failed' } }),
    )
  })

  it('does not emit on a non-terminal status, and never looks up the source', async () => {
    mockPushToOrg.mockResolvedValueOnce(undefined)

    await handler(makeStreamEvent({}), {} as never, () => undefined) // default status: transcribing

    expect(dynamoSend).not.toHaveBeenCalled()
    expect(emitServerAnalytics).not.toHaveBeenCalled()
  })

  it('skips the emit when the source row has no uploader', async () => {
    mockPushToOrg.mockResolvedValueOnce(undefined)
    dynamoSend.mockResolvedValueOnce({ Item: undefined })

    await handler(terminalEvent('done'), {} as never, () => undefined)

    expect(emitServerAnalytics).not.toHaveBeenCalled()
  })

  it('never lets an analytics lookup failure break the (already-completed) WS push', async () => {
    mockPushToOrg.mockResolvedValueOnce(undefined)
    dynamoSend.mockRejectedValueOnce(new Error('ddb down'))

    await expect(handler(terminalEvent('done'), {} as never, () => undefined)).resolves.toBeUndefined()
    expect(mockPushToOrg).toHaveBeenCalledTimes(1)
    expect(emitServerAnalytics).not.toHaveBeenCalled()
  })
})
