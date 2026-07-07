import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from './dynamo.js'
import { config } from '../config.js'

// D-097 — app-level abuse throttling for the unauthenticated OTP endpoints, keyed by email
// and/or IP. Fixed-window bucketing: the window boundary is baked into the partition key
// itself (`bucketStart = floor(now / windowSeconds) * windowSeconds`), not enforced via
// DynamoDB TTL — TTL deletion isn't timed/guaranteed (can lag hours), so it's storage
// cleanup only here, never the thing a window-reset correctness depends on.
export async function checkRateLimit(
  route: string,
  keyType: 'EMAIL' | 'IP',
  keyValue: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const bucketStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds
  const pk = `${route}#${keyType}#${keyValue}#${bucketStart}`
  const expiresAt = bucketStart + windowSeconds * 2 // cleanup grace period, not correctness

  const result = await dynamo.send(new UpdateCommand({
    TableName: config.dynamo.rateLimitsTable,
    Key: { pk },
    UpdateExpression: 'ADD #count :one SET expiresAt = :expiresAt',
    ExpressionAttributeNames: { '#count': 'count' },
    ExpressionAttributeValues: { ':one': 1, ':expiresAt': expiresAt },
    ReturnValues: 'ALL_NEW',
  }))

  const count = (result.Attributes?.['count'] as number | undefined) ?? 0
  return count > limit
}
