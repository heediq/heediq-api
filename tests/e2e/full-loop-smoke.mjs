#!/usr/bin/env node
// Full-loop E2E happy-path smoke (D-147). Runs against the REAL deployed stack (real auth token, real
// API, real WS, real summarization SQS + worker, real chat SQS + worker) — NOT part of the local
// pre-PR gate. Run deliberately after deploying, before handing the environment to dogfood testers.
//
// This is the second D-147 instance. `chat-smoke.mjs` (in heediq-chat) proves the *back half* of the
// MVP critical path (Context → chat). This one proves the *front half and the handoff*: the whole
// capture → classify/extract → review → file-into-Context → chat loop, end to end, on one deploy.
//
// Flow (D-150 text ingest path — deterministic, no GPU):
//   1. create Source                       POST /sources                       -> sourceId
//   2. ingest text (skips transcription)   POST /sources/:id/text              -> enqueues summarization
//   3. wait for classify/extract           WS `classification_ready` (sourceId)  (poll items as fallback)
//   4. read extracted items                GET  /sources/:id/items             -> assert >= 1 proposed
//   5. create a Context to file into       POST /contexts                      -> contextId
//   6. review-approve (keep all items)     POST /sources/:id/review            -> items filed into Context
//   7. assert the filing                   GET  /sources/:id/items             -> kept + contextId set
//   8. chat over the Context               POST /conversations + /messages     -> chat_delta + chat_complete
//   9. clean up the ephemeral Context (cascades conversation/messages; source left as dev noise-free delete)
//
// The audio/transcription ingest path (POST /sources/:id/jobs -> GPU Whisper worker) is deliberately
// NOT exercised here: real transcription needs GPU Spot capacity and is too slow/flaky for a repeatable
// smoke. Cover it with a separate, manually-run audio smoke when that path needs deploy-level proof.
//
// The chat turn is sent with `bypassLedgerGating: true` (D-149): review reconciliation (D-148) may
// leave the fresh Context's Decision Ledger with `needs_review` entries, which would otherwise 409
// `LEDGER_GATED`. This smoke exercises the loop wiring, not the gate — the gate has unit coverage.
//
// Usage:
//   API_BASE=https://<api-id>.execute-api.eu-west-1.amazonaws.com \
//   WS_URL=wss://<ws-id>.execute-api.eu-west-1.amazonaws.com/ws \
//   ID_TOKEN=<cognito id token>            # or TOKEN_FILE, or provision from a seeded test user
//   node tests/e2e/full-loop-smoke.mjs
//
// The Cognito **ID** token (carries custom:orgId/custom:role) is resolved by ./lib/auth.mjs — pass
// ID_TOKEN/TOKEN_FILE, or COGNITO_CLIENT_ID + TEST_USER_EMAIL + TEST_USER_PASSWORD to provision one.
// Exit code: 0 pass, 1 assertion fail, 2 fatal/config error.
import { resolveIdToken } from './lib/auth.mjs'

const API = required('API_BASE', process.env.API_BASE)
const WS = required('WS_URL', process.env.WS_URL)
const TOKEN = await resolveIdToken()

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

// The summarization worker does a Claude classify+extract call — allow generously for a cold Lambda.
const CLASSIFY_TIMEOUT_MS = Number(process.env.CLASSIFY_TIMEOUT_MS ?? 120_000)
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS ?? 90_000)
const WS_OPEN_TIMEOUT_MS = 15_000
const POLL_MS = 2_000

// A short, decision-dense transcript so classify+extract reliably yields at least one ExtractedItem.
const SAMPLE_TEXT = [
  'Team sync — auth milestone.',
  'We decided to ship email/password signup first and add Google SSO in the next sprint.',
  'Action item: Dana wires the password-reset email by Friday.',
  'Open question: do we require MFA for admin accounts at launch?',
  'Decision: the free tier is capped by a usage ratchet, not a hard block.',
].join('\n')

function required(name, value) {
  if (!value) {
    console.error(`Missing required env ${name}. See usage at the top of this file.`)
    process.exit(2)
  }
  return value
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: H, body: body && JSON.stringify(body) })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`)
  return json.data ?? json
}

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?token=${encodeURIComponent(TOKEN)}`)
    const t = setTimeout(() => reject(new Error('WS open timeout')), WS_OPEN_TIMEOUT_MS)
    ws.addEventListener('open', () => {
      clearTimeout(t)
      resolve(ws)
    })
    ws.addEventListener('error', (e) => {
      clearTimeout(t)
      reject(new Error(`WS error: ${e.message ?? e}`))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  log('Opening WS...')
  const ws = await openWs()
  log('WS open.')

  const frames = []
  ws.addEventListener('message', (ev) => {
    try {
      const f = JSON.parse(ev.data)
      frames.push(f)
      if (f.type === 'chat_delta') process.stdout.write('.')
      else log('\nWS frame:', f.type, JSON.stringify(f.payload))
    } catch {
      /* ignore non-JSON frames */
    }
  })

  // 1. Create the Source shell.
  log('POST /sources')
  const { source } = await api('POST', '/api/v1/sources', {
    title: `E2E full-loop smoke ${new Date().toISOString()}`,
  })
  const sourceId = source.sourceId
  log('sourceId =', sourceId)

  // 2. Ingest text — skips transcription, enqueues the summarization (classify+extract) job.
  log('POST /sources/:id/text (enqueues classify+extract)')
  await api('POST', `/api/v1/sources/${sourceId}/text`, { text: SAMPLE_TEXT })

  // 3. Wait for classification_ready over WS; fall back to polling items in case the frame is missed.
  log(`Waiting for classify+extract (${CLASSIFY_TIMEOUT_MS / 1000}s max)...`)
  const classified = await waitForClassification(sourceId, frames)
  if (!classified) fail(ws, 'classify+extract did not complete in time (no classification_ready, no items)')
  log('Classification ready.')

  // 4. Read the extracted items the classifier proposed.
  const items = await api('GET', `/api/v1/sources/${sourceId}/items`)
  const itemList = items.items ?? items
  log('extracted items:', itemList.length)
  if (itemList.length === 0) fail(ws, 'no ExtractedItems were produced from the sample transcript')
  const keptIds = itemList.map((i) => i.itemId)

  // 5. Create a Context to file the kept items into.
  log('POST /contexts')
  const { context } = await api('POST', '/api/v1/contexts', {
    name: `E2E full-loop smoke ${new Date().toISOString()}`,
    domain: 'work',
    description: 'Ephemeral Context created by the full-loop E2E smoke test.',
  })
  const contextId = context.contextId
  log('contextId =', contextId)

  // 6. Review-approve: keep every item, filing them into the Context.
  log(`POST /sources/:id/review (keep ${keptIds.length})`)
  await api('POST', `/api/v1/sources/${sourceId}/review`, { contextId, kept: keptIds })

  // 7. Assert the items were actually filed into the Context.
  const afterReview = await api('GET', `/api/v1/sources/${sourceId}/items`)
  const afterList = afterReview.items ?? afterReview
  const filed = afterList.filter((i) => i.status === 'kept' && i.contextId === contextId)
  log('items filed into Context:', filed.length, '/', afterList.length)
  if (filed.length !== keptIds.length) fail(ws, `expected ${keptIds.length} items filed, got ${filed.length}`)

  // 8. Chat over the freshly-populated Context (bypass D-149 gating — see header).
  log('POST /conversations')
  const { conversation } = await api('POST', `/api/v1/conversations?contextId=${contextId}`, {
    title: 'E2E full-loop smoke thread',
  })
  const conversationId = conversation.conversationId
  log('conversationId =', conversationId)

  log('POST message (enqueues chat job)')
  await api('POST', `/api/v1/conversations/${conversationId}/messages`, {
    content: 'In one short sentence, what did we decide about SSO?',
    bypassLedgerGating: true,
  })

  log(`Waiting for chat_delta/chat_complete (${CHAT_TIMEOUT_MS / 1000}s max)...`)
  const outcome = await waitForChat(conversationId, frames)
  const deltas = frames.filter((f) => f.type === 'chat_delta' && f.payload.conversationId === conversationId)
  const assembled = deltas.map((f) => f.payload.delta).join('')

  log('\n--- RESULT ---')
  log('extracted items  :', itemList.length)
  log('items filed      :', filed.length)
  log('chat outcome     :', outcome)
  log('chat_delta frames:', deltas.length)
  log('assembled reply  :', JSON.stringify(assembled))

  const pass = outcome === 'complete' && deltas.length > 0 && assembled.trim().length > 0
  log(pass ? '✅ PASS' : '❌ FAIL')

  ws.close()
  await cleanup(contextId, sourceId)
  process.exit(pass ? 0 : 1)
}

// Resolve when the source's items are ready — either the classification_ready WS frame lands, or a
// poll of GET /items shows the worker has written items. Belt-and-suspenders so a missed frame (WS
// reconnect, scope) doesn't fail an otherwise-healthy run.
async function waitForClassification(sourceId, frames) {
  const deadline = Date.now() + CLASSIFY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (frames.some((f) => f.type === 'classification_ready' && f.payload.sourceId === sourceId)) return true
    try {
      const items = await api('GET', `/api/v1/sources/${sourceId}/items`)
      const list = items.items ?? items
      if (list.length > 0) return true
    } catch {
      /* transient; keep polling */
    }
    await sleep(POLL_MS)
  }
  return false
}

function waitForChat(conversationId, frames) {
  return new Promise((resolve) => {
    const deadline = setTimeout(() => resolve('timeout'), CHAT_TIMEOUT_MS)
    const iv = setInterval(() => {
      const done = frames.find((f) => f.type === 'chat_complete' && f.payload.conversationId === conversationId)
      const failed = frames.find((f) => f.type === 'chat_failed' && f.payload.conversationId === conversationId)
      if (done || failed) {
        clearInterval(iv)
        clearTimeout(deadline)
        resolve(done ? 'complete' : 'failed')
      }
    }, 250)
  })
}

async function cleanup(contextId, sourceId) {
  // Delete the ephemeral Context (conversation/message rows go with it) and the Source so the dev
  // tree stays tidy. Best-effort — cleanup failure never flips the smoke's pass/fail.
  for (const [label, path] of [
    ['Context', `/api/v1/contexts/${contextId}`],
    ['Source', `/api/v1/sources/${sourceId}`],
  ]) {
    try {
      await api('DELETE', path)
      log('Cleaned up', label)
    } catch (e) {
      log(`Cleanup skipped (${label}):`, e.message)
    }
  }
}

function fail(ws, message) {
  log('❌ FAIL:', message)
  try {
    ws.close()
  } catch {
    /* ignore */
  }
  process.exit(1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
