import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DynamoDBStreamEvent } from 'aws-lambda'

const mockPushToOrg = vi.hoisted(() => vi.fn())

vi.mock('../lib/wsPush.js', () => ({ pushToOrg: mockPushToOrg }))

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
})

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
})
