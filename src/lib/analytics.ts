import { init, track, flush, Types } from '@amplitude/analytics-node'
import {
  buildServerAnalyticsEvent,
  createLogger,
  type ServerAnalyticsEventType,
  type BuildServerAnalyticsEventInput,
} from '@heediq/shared'

// Server-side Amplitude emission for the D-154 cross-service analytics contract. This is the
// backend counterpart to heediq-web's client boundary: it emits the authoritative async outcomes
// and auth-trigger lifecycle events (`source_processing_completed`, `user_provisioned`,
// `login_completed`) the browser can't emit itself, keyed on the same identity
// (`user_id = accountId` D-099, `org` group = orgId) so client and server events stitch together.
//
// Two hard invariants, because emit sites include the login-critical auth triggers (5s Lambda
// budget, D-077):
//   1. **Never throws.** Analytics must never break or fail the operation that emitted it. Every
//      path here — missing key, build/validation error, network failure — is swallowed and logged.
//   2. **Latency-bounded.** The post-track flush races a short timeout that *resolves* (never
//      rejects), so a slow/hung Amplitude ingestion call can't eat into an auth trigger's budget.

const logger = createLogger('heediq-api')

// Max wall-clock the caller will ever wait for the delivery flush. Kept well inside the auth
// triggers' 5s budget; on timeout the event is simply not confirmed-delivered (fire-and-forget
// fallback), never an error.
const FLUSH_TIMEOUT_MS = 800

let initialized = false
let enabled = false

// Lazy one-time init. The key is optional per environment (SSM `/heediq/api/amplitude-api-key`,
// D-050 infra-first): with it unset — local dev, or an env whose param isn't provisioned yet —
// analytics is a clean no-op and the SDK is never configured.
function ensureInit(): boolean {
  if (initialized) return enabled
  initialized = true

  const apiKey = process.env['AMPLITUDE_API_KEY']
  if (!apiKey) {
    enabled = false
    return false
  }

  const options: Types.NodeOptions = {
    // Flush each event promptly — Lambda invocations are short-lived, so there's no long-running
    // process to drain a batched queue later.
    flushQueueSize: 1,
    flushIntervalMillis: 0,
    // Bounded, non-negative retries: the explicit timeout below is the real latency cap, but keep
    // background retry work from lingering past the invocation.
    flushMaxRetries: 1,
    logLevel: Types.LogLevel.Warn,
    loggerProvider: {
      disable: () => {},
      enable: () => {},
      debug: () => {},
      log: () => {},
      warn: (...args: unknown[]) => logger.warn('amplitude', { args }),
      error: (...args: unknown[]) => logger.error('amplitude', { args }),
    },
  }

  try {
    init(apiKey, options)
    enabled = true
  } catch (err: unknown) {
    logger.error('Amplitude init failed; server analytics disabled', {
      error: err instanceof Error ? err.message : String(err),
    })
    enabled = false
  }
  return enabled
}

// Resolves after at most FLUSH_TIMEOUT_MS regardless of whether the flush completes; never rejects.
async function boundedFlush(): Promise<void> {
  await Promise.race([
    flush().promise.then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
  ]).catch(() => undefined)
}

/**
 * Emit one server analytics event to Amplitude. Fail-safe and latency-bounded: on any error, or
 * when no API key is configured, it logs and returns without throwing. `await`-ing it will never
 * delay the caller by more than ~FLUSH_TIMEOUT_MS.
 *
 * The envelope (identity, deterministic `insertId`, `occurredAt`) is built by the shared
 * `buildServerAnalyticsEvent` so the id-prop contract can't drift from the client, then mapped to
 * Amplitude's event shape: `user_id = accountId`, `groups.org = orgId`, `insert_id` for
 * at-least-once dedup, `time` from the domain-event timestamp, id/enum/count props only (D-093).
 */
export async function emitServerAnalytics<T extends ServerAnalyticsEventType>(
  input: BuildServerAnalyticsEventInput<T>,
): Promise<void> {
  if (!ensureInit()) return

  try {
    const envelope = buildServerAnalyticsEvent(input)
    track({
      event_type: envelope.type,
      user_id: envelope.identity.userId,
      groups: { org: envelope.identity.orgId },
      insert_id: envelope.insertId,
      time: Date.parse(envelope.occurredAt),
      event_properties: envelope.payload,
    })
    await boundedFlush()
  } catch (err: unknown) {
    // Swallow everything — a validation miss, a bad timestamp, an SDK error. Analytics is never
    // allowed to surface to the caller (which may be a login-critical auth trigger).
    logger.error('Failed to emit server analytics event', {
      type: input.type,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
