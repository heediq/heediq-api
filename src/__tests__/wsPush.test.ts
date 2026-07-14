import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildWsEvent } from '@heediq/shared'

const mockDynamoSend = vi.hoisted(() => vi.fn())
const mockApiGwSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: {
    dynamo: { wsConnectionsTable: 'heediq-ws-connections' },
    ws: { managementEndpoint: 'https://abc123.execute-api.eu-west-1.amazonaws.com/ws' },
  },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: vi.fn(() => ({ send: mockApiGwSend })),
  PostToConnectionCommand: vi.fn((input) => input),
}))

import { pushToUser, pushToOrg, pushBroadcast } from '../lib/wsPush.js'

const orgId = '00000000-0000-0000-0000-000000000001'
const uuid = '00000000-0000-0000-0000-000000000002'

const envelope = buildWsEvent({
  scope: { kind: 'org', orgId },
  type: 'job_status',
  payload: { jobId: uuid, sourceId: uuid, status: 'transcribing' },
})

beforeEach(() => {
  mockDynamoSend.mockReset()
  mockApiGwSend.mockReset()
})

describe('pushToOrg', () => {
  it('queries the by-org GSI and posts to every connection found', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [{ connectionId: 'c1' }, { connectionId: 'c2' }] })
    mockApiGwSend.mockResolvedValue({})

    await pushToOrg(orgId, envelope)

    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ IndexName: 'by-org', TableName: 'heediq-ws-connections' }),
      }),
    )
    expect(mockApiGwSend).toHaveBeenCalledTimes(2)
  })

  it('deletes the connection row on GoneException instead of throwing', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [{ connectionId: 'stale' }] })
    const gone = Object.assign(new Error('gone'), { name: 'GoneException' })
    mockApiGwSend.mockRejectedValueOnce(gone)
    mockDynamoSend.mockResolvedValueOnce({}) // the DeleteCommand

    await expect(pushToOrg(orgId, envelope)).resolves.toBeUndefined()

    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ Key: { connectionId: 'stale' } }) }),
    )
  })

  it('propagates non-GoneException push errors', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [{ connectionId: 'c1' }] })
    mockApiGwSend.mockRejectedValueOnce(new Error('boom'))

    await expect(pushToOrg(orgId, envelope)).rejects.toThrow('boom')
  })

  it('does nothing when no connections are found', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })

    await pushToOrg(orgId, envelope)

    expect(mockApiGwSend).not.toHaveBeenCalled()
  })
})

describe('pushToUser', () => {
  it('queries the by-user GSI', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    await pushToUser('user-1', envelope)
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ IndexName: 'by-user' }) }),
    )
  })
})

describe('pushBroadcast', () => {
  it('queries the by-broadcast GSI with the constant broadcastKey', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Items: [] })
    await pushBroadcast(envelope)
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          IndexName: 'by-broadcast',
          ExpressionAttributeValues: { ':v': 'ALL' },
        }),
      }),
    )
  })
})
