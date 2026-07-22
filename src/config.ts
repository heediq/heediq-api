// All values injected as Lambda env vars by CDK (ApiStack) at deploy time — D-038.
// Secrets (Stripe, Claude, Recall.ai) are fetched from Secrets Manager at cold start
// via the AWS Parameters and Secrets Lambda Extension, never from env vars.

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

export const config = {
  cognito: {
    userPoolId: requireEnv('COGNITO_USER_POOL_ID'),
    clientId: requireEnv('COGNITO_CLIENT_ID'),
    region: process.env['AWS_REGION'] ?? 'eu-west-1',
  },
  dynamo: {
    sourcesTable: requireEnv('SOURCES_TABLE_NAME'),
    orgsTable: requireEnv('ORGS_TABLE_NAME'),
    usersTable: requireEnv('USERS_TABLE_NAME'),
    jobsTable: requireEnv('JOBS_TABLE_NAME'),
    wsConnectionsTable: requireEnv('WS_CONNECTIONS_TABLE_NAME'),
    userAuthMethodsTable: requireEnv('USER_AUTH_METHODS_TABLE_NAME'),
    authAuditLogTable: requireEnv('AUTH_AUDIT_LOG_TABLE_NAME'),
    rateLimitsTable: requireEnv('RATE_LIMITS_TABLE_NAME'),
    cognitoIdentitiesTable: requireEnv('COGNITO_IDENTITIES_TABLE_NAME'),
    rolesTable: requireEnv('ROLES_TABLE_NAME'),
    groupsTable: requireEnv('GROUPS_TABLE_NAME'),
    roleAssignmentsTable: requireEnv('ROLE_ASSIGNMENTS_TABLE_NAME'),
    auditLogTable: requireEnv('AUDIT_LOG_TABLE_NAME'),
    // Context Library (D-124–D-143) — step 4b's two tables plus context-grants (step 4c-i) and now
    // conversations/chat-messages (step 4c-ii). decision-ledger stays unconsumed until a later
    // sub-step adds its route — added here only once a route actually reads/writes it, per D-103.
    contextsTable: requireEnv('CONTEXTS_TABLE_NAME'),
    extractedItemsTable: requireEnv('EXTRACTED_ITEMS_TABLE_NAME'),
    contextGrantsTable: requireEnv('CONTEXT_GRANTS_TABLE_NAME'),
    conversationsTable: requireEnv('CONVERSATIONS_TABLE_NAME'),
    chatMessagesTable: requireEnv('CHAT_MESSAGES_TABLE_NAME'),
  },
  s3: {
    audioBucket: requireEnv('AUDIO_BUCKET_NAME'),
    presignedUrlExpiresIn: 900, // 15 min
  },
  sqs: {
    transcriptionQueueUrl: requireEnv('TRANSCRIPTION_QUEUE_URL'),
    summarizationQueueUrl: requireEnv('SUMMARIZATION_QUEUE_URL'),
    chatQueueUrl: requireEnv('CHAT_QUEUE_URL'),
  },
  ws: {
    managementEndpoint: requireEnv('WS_MANAGEMENT_ENDPOINT'),
  },
  cors: {
    origins: (process.env['CORS_ORIGINS'] ?? '').split(',').filter(Boolean),
  },
}
