import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiError } from '@heediq/shared'

type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'WEAK_PASSWORD'
  | 'LEDGER_GATED'
  | 'INTERNAL_ERROR'

const statusForCode: Record<ErrorCode, ContentfulStatusCode> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  WEAK_PASSWORD: 400,
  // D-149: chat-time ledger gating — the Context's unsettled ledger entries conflict with sending a
  // turn until they're filled (or the caller bypasses). 409, consistent with other state conflicts.
  LEDGER_GATED: 409,
  INTERNAL_ERROR: 500,
}

export function apiError(
  c: Context,
  code: ErrorCode,
  message: string,
  details?: unknown,
) {
  const body: ApiError = { ok: false, error: { code, message, ...(details !== undefined && { details }) } }
  return c.json(body, statusForCode[code])
}

export function ok<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json({ ok: true, data }, status)
}
