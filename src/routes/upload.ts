import { Hono } from 'hono'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { dynamo } from '../lib/dynamo.js'
import { apiError, ok } from '../lib/errors.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import { PresignUploadRequestSchema, createLogger } from '@heediq/shared'

const s3 = new S3Client({})
const upload = new Hono<AuthContext>()
const logger = createLogger('heediq-api')

function isAwsError(err: unknown): err is { name: string } {
  return typeof err === 'object' && err !== null && 'name' in err
}

// POST /api/v1/upload/presign — get S3 presigned PUT URL for direct client upload
upload.post('/presign', async (c) => {
  const orgId = c.get('orgId')
  const body = await c.req.json()
  const parsed = PresignUploadRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const s3Key = `sources/${orgId}/${parsed.data.sourceId}/audio`

  // Stamp the intended key + sourceType='audio' onto the source row (D-150) — the audio-upload
  // path's counterpart to POST /:id/text. This is what later gates POST /:id/jobs, whose transcribe
  // enqueue requires `audioS3Key`. Conditioned on the source existing so presigning against an
  // unknown or other-org sourceId 404s here rather than minting a URL for a key nothing owns.
  try {
    await dynamo.send(new UpdateCommand({
      TableName: config.dynamo.sourcesTable,
      Key: { orgId, sourceId: parsed.data.sourceId },
      ConditionExpression: 'attribute_exists(sourceId)',
      UpdateExpression: 'SET audioS3Key = :key, sourceType = :sourceType, updatedAt = :now',
      ExpressionAttributeValues: {
        ':key': s3Key,
        ':sourceType': 'audio',
        ':now': new Date().toISOString(),
      },
    }))
  } catch (err: unknown) {
    if (isAwsError(err) && err.name === 'ConditionalCheckFailedException') {
      return apiError(c, 'NOT_FOUND', 'Source not found')
    }
    throw err
  }

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.s3.audioBucket,
      Key: s3Key,
      ContentType: parsed.data.contentType,
      ContentLength: parsed.data.fileSizeBytes,
    }),
    { expiresIn: config.s3.presignedUrlExpiresIn },
  )

  logger.info('Presigned upload URL issued', { orgId, sourceId: parsed.data.sourceId, s3Key })
  return ok(c, { uploadUrl, s3Key, expiresIn: config.s3.presignedUrlExpiresIn })
})

export { upload as uploadRouter }
