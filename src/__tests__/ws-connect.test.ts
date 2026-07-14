import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda'

const mockDynamoSend = vi.hoisted(() => vi.fn())
const mockJwtVerify = vi.hoisted(() => vi.fn())

process.env['WS_CONNECTIONS_TABLE'] = 'heediq-ws-connections'
process.env['COGNITO_USER_POOL_ID'] = 'eu-west-1_test'

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: mockJwtVerify,
}))

const { handler } = await import('../handlers/ws-connect.js')

const userId = '00000000-0000-0000-0000-000000000001'
const orgId = '00000000-0000-0000-0000-000000000002'

function makeEvent(overrides: Partial<APIGatewayProxyWebsocketEventV2> = {}): APIGatewayProxyWebsocketEventV2 {
  return {
    requestContext: {
      eventType: 'CONNECT',
      connectionId: 'conn-1',
      routeKey: '$connect',
      messageId: 'm1',
      extendedRequestId: 'x1',
      requestTime: 'now',
      messageDirection: 'IN',
      stage: 'ws',
      connectedAt: Date.now(),
      requestTimeEpoch: Date.now(),
      requestId: 'r1',
      domainName: 'example.com',
      apiId: 'api1',
    },
    isBase64Encoded: false,
    queryStringParameters: { token: 'valid-token' },
    ...overrides,
  } as APIGatewayProxyWebsocketEventV2
}

beforeEach(() => {
  mockDynamoSend.mockReset()
  mockJwtVerify.mockReset()
})

describe('CONNECT', () => {
  it('rejects a connect with no token', async () => {
    const res = await handler(makeEvent({ queryStringParameters: undefined }), {} as never, () => undefined)
    expect(res).toMatchObject({ statusCode: 401 })
    expect(mockDynamoSend).not.toHaveBeenCalled()
  })

  it('rejects an invalid token', async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error('bad token'))
    const res = await handler(makeEvent(), {} as never, () => undefined)
    expect(res).toMatchObject({ statusCode: 401 })
  })

  it('rejects a token missing required claims', async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: {} })
    const res = await handler(makeEvent(), {} as never, () => undefined)
    expect(res).toMatchObject({ statusCode: 401 })
  })

  it('writes a connection row with userId/orgId/broadcastKey on a valid token', async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: { 'custom:accountId': userId, 'custom:orgId': orgId } })
    mockDynamoSend.mockResolvedValueOnce({})

    const res = await handler(makeEvent(), {} as never, () => undefined)

    expect(res).toMatchObject({ statusCode: 200 })
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Item: expect.objectContaining({
            connectionId: 'conn-1',
            userId,
            orgId,
            broadcastKey: 'ALL',
          }),
        }),
      }),
    )
  })
})

describe('DISCONNECT', () => {
  it('deletes the connection row', async () => {
    mockDynamoSend.mockResolvedValueOnce({})
    const res = await handler(
      makeEvent({
        requestContext: { ...makeEvent().requestContext, eventType: 'DISCONNECT' },
      }),
      {} as never,
      () => undefined,
    )
    expect(res).toMatchObject({ statusCode: 200 })
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ Key: { connectionId: 'conn-1' } }) }),
    )
  })
})

describe('MESSAGE', () => {
  it('is a no-op ack', async () => {
    const res = await handler(
      makeEvent({
        requestContext: { ...makeEvent().requestContext, eventType: 'MESSAGE' },
      }),
      {} as never,
      () => undefined,
    )
    expect(res).toMatchObject({ statusCode: 200 })
    expect(mockDynamoSend).not.toHaveBeenCalled()
  })
})
