import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DynamoDBStreamEvent } from 'aws-lambda'

const mockPushToOrg = vi.hoisted(() => vi.fn())

vi.mock('../lib/wsPush.js', () => ({ pushToOrg: mockPushToOrg }))

const { handler } = await import('../handlers/classification-pusher.js')

const sourceId = '00000000-0000-0000-0000-000000000002'
const orgId = '00000000-0000-0000-0000-000000000003'
const contextId = '00000000-0000-0000-0000-0000000000c1'

// A pending_review Source NewImage in DynamoDB attribute-value form (as DDB Streams delivers it).
function makeStreamEvent(overrides: {
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE'
  newImage?: Record<string, unknown>
}): DynamoDBStreamEvent {
  const newImage = overrides.newImage ?? {
    sourceId: { S: sourceId },
    orgId: { S: orgId },
    classification: { S: 'pending_review' },
    proposedClassification: {
      M: {
        proposedContextId: { S: contextId },
        domain: { S: 'work' },
        labels: { L: [{ S: 'auth' }] },
        confidence: { N: '0.91' },
      },
    },
  }
  return {
    Records: [
      { eventID: 'e1', eventName: overrides.eventName ?? 'MODIFY', dynamodb: { NewImage: newImage as never } } as never,
    ],
  }
}

beforeEach(() => {
  mockPushToOrg.mockReset()
})

describe('classification-pusher handler', () => {
  it('pushes a classification_ready event at org scope on a pending_review MODIFY', async () => {
    mockPushToOrg.mockResolvedValueOnce(undefined)

    await handler(makeStreamEvent({}), {} as never, () => undefined)

    expect(mockPushToOrg).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({
        type: 'classification_ready',
        scope: { kind: 'org', orgId },
        payload: expect.objectContaining({
          sourceId,
          proposedContextId: contextId,
          domain: 'work',
          labels: ['auth'],
          confidence: 0.91,
        }),
      }),
    )
  })

  it('ignores INSERT and REMOVE events', async () => {
    await handler(makeStreamEvent({ eventName: 'INSERT' }), {} as never, () => undefined)
    await handler(makeStreamEvent({ eventName: 'REMOVE' }), {} as never, () => undefined)
    expect(mockPushToOrg).not.toHaveBeenCalled()
  })

  it('skips a Source not at the review gate (classification != pending_review)', async () => {
    await handler(
      makeStreamEvent({
        newImage: {
          sourceId: { S: sourceId },
          orgId: { S: orgId },
          classification: { S: 'approved' },
        },
      }),
      {} as never,
      () => undefined,
    )
    expect(mockPushToOrg).not.toHaveBeenCalled()
  })

  it('skips (without throwing) a pending_review Source whose proposal is malformed', async () => {
    await handler(
      makeStreamEvent({
        newImage: {
          sourceId: { S: sourceId },
          orgId: { S: orgId },
          classification: { S: 'pending_review' },
          // proposedClassification missing both proposedContextId and newContextName → invalid
          proposedClassification: { M: { domain: { S: 'work' }, labels: { L: [] }, confidence: { N: '0.9' } } },
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
