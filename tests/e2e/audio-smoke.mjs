#!/usr/bin/env node
// Audio / transcription-path E2E smoke (D-156). The deploy-level counterpart to `full-loop-smoke.mjs`:
// that one drives the deterministic text-ingest path (POST /:id/text, no GPU); THIS one exercises the
// audio path end to end — presign → S3 PUT → POST /:id/jobs → GPU Whisper worker → summarization →
// classify/extract — the one leg the full-loop smoke deliberately skips because it needs GPU Spot.
//
// Because it depends on EC2 GPU Spot capacity coming up, it is slow and capacity-flaky by nature, so
// it is OPT-IN: not part of the promote-to-staging gate's default run, invoked on demand when the
// transcription path itself needs deploy-level proof (`pnpm e2e:audio`).
//
// Flow (D-060 audio ingest path):
//   1. create Source                     POST /sources                       -> sourceId
//   2. presign an audio upload           POST /upload/presign                -> uploadUrl (+ stamps audioS3Key)
//   3. PUT the audio bytes to S3         PUT  uploadUrl                      -> 200
//   4. enqueue transcription             POST /sources/:id/jobs {model:small}-> job (queued)
//   5. wait for the pipeline to finish   WS `job_status` -> done             (poll source status as fallback)
//   6. assert the source transcribed     GET  /sources/:id                   -> status ready + transcript present
//   7. clean up the ephemeral Source
//
// What it proves vs. what it does NOT: the assertion is that the *pipeline ran to a terminal `done`/
// `ready`* — presign, S3, the job enqueue, the GPU worker picking the task up, transcription, and the
// summarization handoff are all wired on this deploy. It uses a synthesized tone WAV (no committed
// binary fixture), so it does NOT assert transcript *wording* or that classify produced items —
// Whisper on a contentless tone yields little. Transcript/item counts are logged, best-effort, never
// gate pass/fail. Wording correctness is the summarization worker's own concern, not this smoke's.
//
// Usage:
//   API_BASE=https://<api-id>.execute-api.eu-west-1.amazonaws.com \
//   WS_URL=wss://<ws-id>.execute-api.eu-west-1.amazonaws.com/ws \
//   ID_TOKEN=<cognito id token>            # or TOKEN_FILE, or COGNITO_CLIENT_ID+TEST_USER_* to provision
//   node tests/e2e/audio-smoke.mjs
//
// The Cognito **ID** token is resolved by ./lib/auth.mjs — same contract as the full-loop smoke.
// Exit code: 0 pass, 1 assertion fail, 2 fatal/config error.
import { resolveIdToken } from './lib/auth.mjs'

const API = required('API_BASE', process.env.API_BASE)
const WS = required('WS_URL', process.env.WS_URL)
const TOKEN = await resolveIdToken()

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

// GPU Spot can be cold — a fresh instance provisions, pulls the model, then transcribes. Allow
// generously; the whole point of keeping this opt-in is that this wait is long and capacity-bound.
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS ?? 600_000)
const WS_OPEN_TIMEOUT_MS = 15_000
const POLL_MS = 5_000

function required(name, value) {
  if (!value) {
    console.error(`Missing required env ${name}. See usage at the top of this file.`)
    process.exit(2)
  }
  return value
}

// A ~1s 16kHz mono 16-bit PCM WAV of a 440Hz tone — a real, decodable audio signal for Whisper to
// process, generated in-process so the repo carries no binary fixture. Contentless on purpose: this
// smoke proves the pipeline runs, not that a specific sentence comes back.
function makeToneWav({ seconds = 1, sampleRate = 16_000, freq = 440 } = {}) {
  const numSamples = seconds * sampleRate
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // PCM fmt chunk size
  buf.writeUInt16LE(1, 20) // audioFormat = PCM
  buf.writeUInt16LE(1, 22) // channels = mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byteRate = sampleRate * blockAlign
  buf.writeUInt16LE(2, 32) // blockAlign = channels * bytesPerSample
  buf.writeUInt16LE(16, 34) // bitsPerSample
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < numSamples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 8000), 44 + i * 2)
  }
  return buf
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
      log('WS frame:', f.type, JSON.stringify(f.payload))
    } catch {
      /* ignore non-JSON frames */
    }
  })

  // 1. Create the Source shell.
  log('POST /sources')
  const { source } = await api('POST', '/api/v1/sources', {
    title: `E2E audio smoke ${new Date().toISOString()}`,
  })
  const sourceId = source.sourceId
  log('sourceId =', sourceId)

  // 2. Presign an audio upload — also stamps audioS3Key + sourceType='audio' onto the source, which
  //    is what gates POST /:id/jobs below.
  const wav = makeToneWav()
  log('POST /upload/presign', `(${wav.length} bytes)`)
  const { uploadUrl } = await api('POST', '/api/v1/upload/presign', {
    sourceId,
    contentType: 'audio/wav',
    fileSizeBytes: wav.length,
  })

  // 3. PUT the bytes straight to S3. Content-Type + Content-Length must match what was signed.
  log('PUT audio -> S3')
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: wav })
  if (!put.ok) await fail(ws, sourceId, `S3 PUT failed -> ${put.status}: ${await put.text()}`)

  // 4. Enqueue transcription (free-tier `small` model — no D-060 paid gating).
  log('POST /sources/:id/jobs (small)')
  const { job } = await api('POST', `/api/v1/sources/${sourceId}/jobs`, { sourceId, model: 'small' })
  log('jobId =', job.jobId, 'status =', job.status)

  // 5. Wait for the transcription+summarization pipeline to reach a terminal state.
  log(`Waiting for transcription (${TRANSCRIBE_TIMEOUT_MS / 1000}s max — GPU Spot may be cold)...`)
  const terminal = await waitForTranscription(sourceId, job.jobId, frames, ws)
  log('Terminal state:', terminal.via, '=', terminal.status)

  // 6. Assert the source actually transcribed. Terminal `done`/`ready` is the pass signal; transcript
  //    text is best-effort (a tone carries no words) so it's logged, not asserted.
  const finalSource = (await api('GET', `/api/v1/sources/${sourceId}`)).source ?? {}
  const transcript = finalSource.transcript ?? ''
  log('\n--- RESULT ---')
  log('source status    :', finalSource.status)
  log('transcript length:', transcript.length, transcript.length ? `(${JSON.stringify(transcript.slice(0, 80))}…)` : '(empty — expected for a tone)')

  const pass = terminal.status === 'done' || finalSource.status === 'ready'
  log(pass ? '✅ PASS — audio pipeline ran end to end' : '❌ FAIL — pipeline did not reach a terminal ready state')

  ws.close()
  await cleanup(sourceId)
  process.exit(pass ? 0 : 1)
}

// Resolve when the job reaches a terminal state: a `job_status` frame of `done`/`failed`, or the
// source row flips to `ready`/`failed`. Belt-and-suspenders so a missed WS frame (reconnect, scope)
// doesn't hang an otherwise-healthy run past the long GPU timeout.
async function waitForTranscription(sourceId, jobId, frames, ws) {
  const deadline = Date.now() + TRANSCRIBE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const jf = frames.find(
      (f) => f.type === 'job_status' && f.payload.jobId === jobId && ['done', 'failed'].includes(f.payload.status),
    )
    if (jf) {
      if (jf.payload.status === 'failed') await fail(ws, sourceId, `transcription job reported status=failed`)
      return { via: 'ws', status: jf.payload.status }
    }
    try {
      const src = (await api('GET', `/api/v1/sources/${sourceId}`)).source ?? {}
      if (src.status === 'failed') await fail(ws, sourceId, `source flipped to status=failed during transcription`)
      if (src.status === 'ready') return { via: 'poll', status: 'done' }
    } catch {
      /* transient; keep polling */
    }
    await sleep(POLL_MS)
  }
  await fail(ws, sourceId, `transcription did not reach a terminal state within ${TRANSCRIBE_TIMEOUT_MS / 1000}s`)
}

async function cleanup(sourceId) {
  // Delete the ephemeral Source so the dev tree stays tidy. Best-effort — never flips pass/fail.
  try {
    await api('DELETE', `/api/v1/sources/${sourceId}`)
    log('Cleaned up Source')
  } catch (e) {
    log('Cleanup skipped (Source):', e.message)
  }
}

// Await cleanup, then exit — MUST be awaited by callers so no code runs past the failure (an
// unawaited exit lets the caller fall through, e.g. into `terminal.via` on undefined).
async function fail(ws, sourceId, message) {
  log('❌ FAIL:', message)
  try {
    ws.close()
  } catch {
    /* ignore */
  }
  await cleanup(sourceId)
  process.exit(1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
