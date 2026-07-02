import { Hono } from 'hono'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { apiError, ok } from '../lib/errors.js'
import { config } from '../config.js'
import type { AuthContext } from '../middleware/auth.js'
import { PresignUploadRequestSchema } from '@heediq/shared'

const s3 = new S3Client({})
const upload = new Hono<AuthContext>()

// POST /api/v1/upload/presign — get S3 presigned PUT URL for direct client upload
upload.post('/presign', async (c) => {
  const orgId = c.get('orgId')
  const body = await c.req.json()
  const parsed = PresignUploadRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(c, 'BAD_REQUEST', 'Invalid request body', parsed.error.flatten())
  }

  const s3Key = `sources/${orgId}/${parsed.data.sourceId}/audio`
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

  return ok(c, { uploadUrl, s3Key, expiresIn: config.s3.presignedUrlExpiresIn })
})

export { upload as uploadRouter }
