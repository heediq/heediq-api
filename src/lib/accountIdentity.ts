import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from './dynamo.js'

// Shared identity-resolution helpers (D-099). `heediq-cognito-identities` (pk = `sub`) is the
// deterministic map from every Cognito identity (native or federated) a person has ever signed
// in with onto one internal `accountId`. It's consulted before the fragile by-email GSI guess
// (`resolveAccountIdByEmail`) that caused two independent Cognito identities to permanently
// diverge onto different DynamoDB rows once AdminLinkProviderForUser repointed a federated
// login's future `sub` — see D-099 for the full incident. Callers should always try
// `resolveAccountIdBySub` first and only fall back to the email guess (self-heal) when no
// mapping exists yet, then persist the mapping via `linkIdentity` so future logins are O(1).

export async function resolveAccountIdBySub(
  identitiesTable: string,
  sub: string,
): Promise<string | undefined> {
  const result = await dynamo.send(new GetCommand({
    TableName: identitiesTable,
    Key: { sub },
  }))
  return result.Item?.['accountId'] as string | undefined
}

export async function linkIdentity(
  identitiesTable: string,
  sub: string,
  accountId: string,
): Promise<void> {
  await dynamo.send(new PutCommand({
    TableName: identitiesTable,
    Item: { sub, accountId, linkedAt: new Date().toISOString() },
  }))
}

// Fallback-only: the pre-D-099 email-lookup guess, kept for self-healing identities that
// signed in before the identities table existed. `Limit: 1` is inherently nondeterministic
// when two rows share an email — callers must treat a hit here as provisional and immediately
// call `linkIdentity` to pin the resolved sub to a definitive accountId going forward.
export async function resolveAccountIdByEmail(
  usersTable: string,
  email: string,
): Promise<string | undefined> {
  const result = await dynamo.send(new QueryCommand({
    TableName: usersTable,
    IndexName: 'by-email',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: { ':email': email },
    Limit: 1,
  }))
  const item = result.Items?.[0]
  return item?.['userId'] as string | undefined
}
