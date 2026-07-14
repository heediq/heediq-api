import { QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi'
import { createLogger, type WsEventEnvelope } from '@heediq/shared'
import { dynamo } from './dynamo.js'
import { config } from '../config.js'

const logger = createLogger('heediq-api')

const apiGwManagement = new ApiGatewayManagementApiClient({
  endpoint: config.ws.managementEndpoint,
})

function isAwsError(err: unknown): err is { name: string } {
  return typeof err === 'object' && err !== null && 'name' in err
}

async function queryConnectionIds(indexName: string, keyName: string, keyValue: string): Promise<string[]> {
  const res = await dynamo.send(new QueryCommand({
    TableName: config.dynamo.wsConnectionsTable,
    IndexName: indexName,
    KeyConditionExpression: `${keyName} = :v`,
    ExpressionAttributeValues: { ':v': keyValue },
  }))
  return (res.Items ?? []).map((item) => item['connectionId'] as string)
}

// Fans an envelope out to every connectionId found, deleting rows that PostToConnection reports
// as gone (410 GoneException — the client disconnected without a clean $disconnect) so the
// by-user/by-org/by-broadcast GSIs stay free of stale connections (D-109).
async function fanOut(envelope: WsEventEnvelope, connectionIds: string[]): Promise<void> {
  const body = Buffer.from(JSON.stringify(envelope))
  await Promise.all(
    connectionIds.map(async (connectionId) => {
      try {
        await apiGwManagement.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: body }))
      } catch (err: unknown) {
        if (isAwsError(err) && err.name === 'GoneException') {
          await dynamo.send(new DeleteCommand({
            TableName: config.dynamo.wsConnectionsTable,
            Key: { connectionId },
          }))
          logger.info('Removed stale WS connection', { connectionId })
          return
        }
        logger.error('Failed to push WS event to connection', {
          connectionId,
          type: envelope.type,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    }),
  )
}

export async function pushToUser(userId: string, envelope: WsEventEnvelope): Promise<void> {
  const connectionIds = await queryConnectionIds('by-user', 'userId', userId)
  await fanOut(envelope, connectionIds)
}

export async function pushToOrg(orgId: string, envelope: WsEventEnvelope): Promise<void> {
  const connectionIds = await queryConnectionIds('by-org', 'orgId', orgId)
  await fanOut(envelope, connectionIds)
}

export async function pushBroadcast(envelope: WsEventEnvelope): Promise<void> {
  const connectionIds = await queryConnectionIds('by-broadcast', 'broadcastKey', 'ALL')
  await fanOut(envelope, connectionIds)
}
