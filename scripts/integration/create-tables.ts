// Mirrors heediq-infra/lib/foundation/tables.ts table/GSI definitions against DynamoDB Local.
// Kept in sync by hand — flagged as a drift risk in both READMEs and 10-consistency-check.md.
import {
  CreateTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  type CreateTableCommandInput,
  type GlobalSecondaryIndex,
} from '@aws-sdk/client-dynamodb'

const ENDPOINT = process.env['DYNAMODB_ENDPOINT'] ?? 'http://localhost:8000'

const client = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: 'local',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
})

type TableDef = {
  tableName: string
  partitionKey: string
  sortKey?: string
  gsis?: { indexName: string; partitionKey: string; sortKey?: string }[]
}

const TABLES: TableDef[] = [
  {
    tableName: 'heediq-sources',
    partitionKey: 'orgId',
    sortKey: 'sourceId',
    gsis: [
      { indexName: 'by-org-created', partitionKey: 'orgId', sortKey: 'createdAt' },
      { indexName: 'by-user-created', partitionKey: 'userId', sortKey: 'createdAt' },
    ],
  },
  {
    tableName: 'heediq-orgs',
    partitionKey: 'orgId',
    gsis: [{ indexName: 'by-email-domain', partitionKey: 'emailDomain' }],
  },
  {
    tableName: 'heediq-users',
    partitionKey: 'userId',
    gsis: [
      { indexName: 'by-org', partitionKey: 'orgId', sortKey: 'userId' },
      { indexName: 'by-email', partitionKey: 'email' },
    ],
  },
  { tableName: 'heediq-cognito-identities', partitionKey: 'sub' },
  { tableName: 'heediq-user-auth-methods', partitionKey: 'pk', sortKey: 'sk' },
  { tableName: 'heediq-auth-audit-log', partitionKey: 'pk', sortKey: 'sk' },
  { tableName: 'heediq-rate-limits', partitionKey: 'pk' },
  { tableName: 'heediq-jobs', partitionKey: 'sourceId' },
  {
    tableName: 'heediq-ws-connections',
    partitionKey: 'connectionId',
    gsis: [
      { indexName: 'by-user', partitionKey: 'userId' },
      { indexName: 'by-org', partitionKey: 'orgId' },
      { indexName: 'by-broadcast', partitionKey: 'broadcastKey' },
    ],
  },
  { tableName: 'heediq-roles', partitionKey: 'pk', sortKey: 'sk' },
  { tableName: 'heediq-groups', partitionKey: 'pk', sortKey: 'sk' },
  {
    tableName: 'heediq-role-assignments',
    partitionKey: 'pk',
    sortKey: 'sk',
    gsis: [{ indexName: 'by-role', partitionKey: 'roleId' }],
  },
  {
    tableName: 'heediq-audit-log',
    partitionKey: 'pk',
    sortKey: 'sk',
    gsis: [{ indexName: 'by-user', partitionKey: 'actorUserId', sortKey: 'sk' }],
  },
]

function toCreateTableInput(def: TableDef): CreateTableCommandInput {
  const attributeNames = new Set<string>([def.partitionKey])
  if (def.sortKey) attributeNames.add(def.sortKey)
  for (const gsi of def.gsis ?? []) {
    attributeNames.add(gsi.partitionKey)
    if (gsi.sortKey) attributeNames.add(gsi.sortKey)
  }

  const globalSecondaryIndexes: GlobalSecondaryIndex[] | undefined = def.gsis?.map((gsi) => ({
    IndexName: gsi.indexName,
    KeySchema: [
      { AttributeName: gsi.partitionKey, KeyType: 'HASH' },
      ...(gsi.sortKey ? [{ AttributeName: gsi.sortKey, KeyType: 'RANGE' as const }] : []),
    ],
    Projection: { ProjectionType: 'ALL' },
  }))

  return {
    TableName: def.tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [...attributeNames].map((name) => ({
      AttributeName: name,
      AttributeType: 'S',
    })),
    KeySchema: [
      { AttributeName: def.partitionKey, KeyType: 'HASH' },
      ...(def.sortKey ? [{ AttributeName: def.sortKey, KeyType: 'RANGE' as const }] : []),
    ],
    GlobalSecondaryIndexes: globalSecondaryIndexes,
  }
}

async function main() {
  const existing = await client.send(new ListTablesCommand({}))
  const existingNames = new Set(existing.TableNames ?? [])

  for (const def of TABLES) {
    if (existingNames.has(def.tableName)) {
      console.log(`skip (exists): ${def.tableName}`)
      continue
    }
    await client.send(new CreateTableCommand(toCreateTableInput(def)))
    console.log(`created: ${def.tableName}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
