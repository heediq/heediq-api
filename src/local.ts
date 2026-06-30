// Local dev server — not deployed. Run with: pnpm dev
import { serve } from '@hono/node-server'
import { app } from './app.js'

const port = Number(process.env['PORT'] ?? 3000)
console.log(`heediq-api running at http://localhost:${port}`)
serve({ fetch: app.fetch, port })
