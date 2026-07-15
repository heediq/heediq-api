import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

// DYNAMODB_ENDPOINT is only ever set by tests/integration (DynamoDB Local) — unset in every
// deployed Lambda env, so production always targets real AWS.
const localEndpoint = process.env['DYNAMODB_ENDPOINT']
const client = new DynamoDBClient(
  localEndpoint
    ? { endpoint: localEndpoint, region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
    : {},
)
export const dynamo = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
})
