import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda'
import { PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createLogger } from '@heediq/shared'
import { dynamo } from '../lib/dynamo.js'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

const WS_CONNECTIONS_TABLE = requireEnv('WS_CONNECTIONS_TABLE')
const COGNITO_USER_POOL_ID = requireEnv('COGNITO_USER_POOL_ID')
const COGNITO_REGION = process.env['AWS_REGION'] ?? 'eu-west-1'

// 24h connection TTL — a safety net for rows that miss a clean $disconnect (client crash,
// network drop); wsPush.ts also self-heals by deleting a row the moment PostToConnection
// reports GoneException, so this is a backstop, not the primary cleanup path.
const CONNECTION_TTL_SECONDS = 24 * 60 * 60

const JWKS = createRemoteJWKSet(
  new URL(`https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}/.well-known/jwks.json`),
)

const logger = createLogger('heediq-api')

// $connect / $disconnect / $default all route to this Lambda (websocket-stack.ts) — only
// CONNECT and DISCONNECT do anything; MESSAGE (client -> server) has no defined use yet (D-109
// framework is server-push only) so it's a no-op ack.
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const { eventType, connectionId } = event.requestContext

  if (eventType === 'DISCONNECT') {
    await dynamo.send(new DeleteCommand({ TableName: WS_CONNECTIONS_TABLE, Key: { connectionId } }))
    logger.info('WS connection closed', { connectionId })
    return { statusCode: 200, body: '' }
  }

  if (eventType === 'MESSAGE') {
    return { statusCode: 200, body: '' }
  }

  // CONNECT — token passed as a query string param since WebSocket clients can't set custom
  // headers during the handshake in browsers.
  const token = event.queryStringParameters?.['token']
  if (!token) {
    logger.warn('WS connect rejected — missing token', { connectionId })
    return { statusCode: 401, body: 'Missing token' }
  }

  let userId: string | undefined
  let orgId: string | undefined
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`,
    })
    userId = payload['custom:accountId'] as string | undefined
    orgId = payload['custom:orgId'] as string | undefined
  } catch {
    logger.warn('WS connect rejected — invalid token', { connectionId })
    return { statusCode: 401, body: 'Invalid token' }
  }

  if (!userId || !orgId) {
    logger.warn('WS connect rejected — token missing required claims', { connectionId })
    return { statusCode: 401, body: 'Token missing required claims' }
  }

  await dynamo.send(new PutCommand({
    TableName: WS_CONNECTIONS_TABLE,
    Item: {
      connectionId,
      userId,
      orgId,
      broadcastKey: 'ALL',
      expiresAt: Math.floor(Date.now() / 1000) + CONNECTION_TTL_SECONDS,
    },
  }))
  logger.info('WS connection opened', { connectionId, userId, orgId })

  return { statusCode: 200, body: '' }
}
