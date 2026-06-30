import { createMiddleware } from 'hono/factory'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { config } from '../config.js'
import { apiError } from '../lib/errors.js'
import type { OrgRole } from '@heediq/shared'

// JWKS fetched once per cold start and cached; jose re-fetches on key rotation.
const JWKS = createRemoteJWKSet(
  new URL(
    `https://cognito-idp.${config.cognito.region}.amazonaws.com/${config.cognito.userPoolId}/.well-known/jwks.json`,
  ),
)

export type AuthContext = {
  Variables: {
    userId: string
    orgId: string
    email: string
    role: OrgRole
  }
}

export const authMiddleware = createMiddleware<AuthContext>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return apiError(c, 'UNAUTHORIZED', 'Missing or invalid Authorization header')
  }

  const token = authHeader.slice(7)
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://cognito-idp.${config.cognito.region}.amazonaws.com/${config.cognito.userPoolId}`,
    })

    const userId = payload['sub'] as string | undefined
    const orgId = payload['custom:orgId'] as string | undefined
    const email = payload['email'] as string | undefined
    const role = payload['custom:role'] as OrgRole | undefined

    if (!userId || !orgId || !email || !role) {
      return apiError(c, 'UNAUTHORIZED', 'Token missing required claims')
    }

    c.set('userId', userId)
    c.set('orgId', orgId)
    c.set('email', email)
    c.set('role', role)
    await next()
  } catch {
    return apiError(c, 'UNAUTHORIZED', 'Invalid or expired token')
  }
})
