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
    region: process.env['AWS_REGION'] ?? 'eu-west-1',
  },
  dynamo: {
    recordingsTable: requireEnv('RECORDINGS_TABLE_NAME'),
    orgsTable: requireEnv('ORGS_TABLE_NAME'),
    usersTable: requireEnv('USERS_TABLE_NAME'),
    jobsTable: requireEnv('JOBS_TABLE_NAME'),
    wsConnectionsTable: requireEnv('WS_CONNECTIONS_TABLE_NAME'),
  },
  s3: {
    audioBucket: requireEnv('AUDIO_BUCKET_NAME'),
    presignedUrlExpiresIn: 900, // 15 min
  },
  sqs: {
    transcriptionQueueUrl: requireEnv('TRANSCRIPTION_QUEUE_URL'),
    summarizationQueueUrl: requireEnv('SUMMARIZATION_QUEUE_URL'),
  },
  cors: {
    origins: (process.env['CORS_ORIGINS'] ?? '').split(',').filter(Boolean),
  },
}
