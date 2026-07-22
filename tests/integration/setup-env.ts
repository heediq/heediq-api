// Runs before every integration test file's imports (Vitest `setupFiles`) so that config.ts's
// eager `requireEnv()` calls at module-load time all succeed. Only the DynamoDB vars are real —
// Cognito/S3/SQS/WS vars are unused by DynamoDB Local tests but still required by config.ts's
// single shared module, so they get harmless placeholder values.
process.env['DYNAMODB_ENDPOINT'] ??= 'http://localhost:8000'

const placeholders: Record<string, string> = {
  COGNITO_USER_POOL_ID: 'local-pool',
  COGNITO_CLIENT_ID: 'local-client',
  AUDIO_BUCKET_NAME: 'local-bucket',
  TRANSCRIPTION_QUEUE_URL: 'http://localhost/local-transcription-queue',
  SUMMARIZATION_QUEUE_URL: 'http://localhost/local-summarization-queue',
  WS_MANAGEMENT_ENDPOINT: 'http://localhost/local-ws',
  CORS_ORIGINS: 'http://localhost',

  SOURCES_TABLE_NAME: 'heediq-sources',
  ORGS_TABLE_NAME: 'heediq-orgs',
  USERS_TABLE_NAME: 'heediq-users',
  JOBS_TABLE_NAME: 'heediq-jobs',
  WS_CONNECTIONS_TABLE_NAME: 'heediq-ws-connections',
  USER_AUTH_METHODS_TABLE_NAME: 'heediq-user-auth-methods',
  AUTH_AUDIT_LOG_TABLE_NAME: 'heediq-auth-audit-log',
  RATE_LIMITS_TABLE_NAME: 'heediq-rate-limits',
  COGNITO_IDENTITIES_TABLE_NAME: 'heediq-cognito-identities',
  ROLES_TABLE_NAME: 'heediq-roles',
  GROUPS_TABLE_NAME: 'heediq-groups',
  ROLE_ASSIGNMENTS_TABLE_NAME: 'heediq-role-assignments',
  AUDIT_LOG_TABLE_NAME: 'heediq-audit-log',
  CONTEXTS_TABLE_NAME: 'heediq-contexts',
  EXTRACTED_ITEMS_TABLE_NAME: 'heediq-extracted-items',
  CONTEXT_GRANTS_TABLE_NAME: 'heediq-context-grants',
  CONVERSATIONS_TABLE_NAME: 'heediq-conversations',
  CHAT_MESSAGES_TABLE_NAME: 'heediq-chat-messages',
  CHAT_QUEUE_URL: 'http://localhost/local-chat-queue',
}

for (const [key, value] of Object.entries(placeholders)) {
  process.env[key] ??= value
}
