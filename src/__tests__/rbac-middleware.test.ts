import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { requirePermission } from '../middleware/rbac.js'
import type { AuthContext } from '../middleware/auth.js'

function makeApp(permissions: string[]) {
  const app = new Hono<AuthContext>()
  app.use('*', async (c, next) => {
    c.set('permissions', permissions as AuthContext['Variables']['permissions'])
    await next()
  })
  app.get('/gated', requirePermission('org:manage-roles'), (c) => c.json({ ok: true }))
  return app
}

describe('requirePermission', () => {
  it('allows the request through when the token has the required permission', async () => {
    const res = await makeApp(['org:manage-roles']).request('/gated')
    expect(res.status).toBe(200)
  })

  it('returns 403 FORBIDDEN when the token lacks the required permission — pure in-token check, no DB read (D-105)', async () => {
    const res = await makeApp(['sources:read']).request('/gated')
    expect(res.status).toBe(403)
    const body = await res.json() as { ok: boolean; error: { code: string; message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toMatch(/org:manage-roles/)
  })

  it('returns 403 when the permissions array is empty', async () => {
    const res = await makeApp([]).request('/gated')
    expect(res.status).toBe(403)
  })
})
