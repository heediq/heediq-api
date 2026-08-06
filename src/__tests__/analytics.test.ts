import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BuildServerAnalyticsEventInput } from '@heediq/shared'

// Mock only the Amplitude SDK — the shared `buildServerAnalyticsEvent` runs for real so the tests
// assert the actual envelope→Amplitude mapping (user_id/groups/insert_id/time), not a re-mock of it.
const init = vi.fn()
const track = vi.fn()
const flush = vi.fn(() => ({ promise: Promise.resolve() }))

const userId = 'acct-11111111'
// orgId must be a real UUID — the shared identity schema validates it as such (D-154 join key).
const orgId = '22222222-2222-4222-8222-222222222222'

// The module caches init/enabled at load, so re-import per test after resetting the module registry
// to exercise the with-key / without-key paths independently. `vi.doMock` (not the hoisted
// `vi.mock`) is re-applied to each fresh module graph — a plain `vi.mock` silently drops off the
// re-imported module after `vi.resetModules()` in this vitest version.
async function loadEmit() {
  vi.resetModules()
  vi.doMock('@amplitude/analytics-node', () => ({
    init,
    track,
    flush,
    Types: { LogLevel: { None: 0, Error: 1, Warn: 2, Verbose: 3, Debug: 4 } },
  }))
  return (await import('../lib/analytics.js')).emitServerAnalytics
}

const provisioned: BuildServerAnalyticsEventInput<'user_provisioned'> = {
  identity: { userId, orgId },
  type: 'user_provisioned',
  payload: { tier: 'free' },
}

beforeEach(() => {
  init.mockClear()
  track.mockClear()
  flush.mockClear()
  flush.mockReturnValue({ promise: Promise.resolve() })
})

afterEach(() => {
  delete process.env['AMPLITUDE_API_KEY']
})

describe('emitServerAnalytics — no-op without a key', () => {
  it('never inits or tracks when AMPLITUDE_API_KEY is unset', async () => {
    delete process.env['AMPLITUDE_API_KEY']
    const emit = await loadEmit()

    await emit(provisioned)

    expect(init).not.toHaveBeenCalled()
    expect(track).not.toHaveBeenCalled()
  })
})

describe('emitServerAnalytics — with a key', () => {
  beforeEach(() => {
    process.env['AMPLITUDE_API_KEY'] = 'test-key'
  })

  it('maps the envelope to an Amplitude event: user_id=accountId, org group, id-only props', async () => {
    const emit = await loadEmit()

    await emit(provisioned)

    expect(init).toHaveBeenCalledTimes(1)
    expect(init).toHaveBeenCalledWith('test-key', expect.any(Object))
    expect(track).toHaveBeenCalledTimes(1)
    const event = track.mock.calls[0]?.[0] as Record<string, unknown>
    expect(event['event_type']).toBe('user_provisioned')
    expect(event['user_id']).toBe(userId)
    expect(event['groups']).toEqual({ org: orgId })
    expect(event['event_properties']).toEqual({ tier: 'free' })
    expect(typeof event['insert_id']).toBe('string')
    expect(typeof event['time']).toBe('number')
    // Identity is the app-owned accountId (D-099) — never a Cognito sub or an email.
    expect(event).not.toHaveProperty('user_properties.email')
    expect(JSON.stringify(event)).not.toContain('@')
  })

  it('flushes after tracking so the short-lived Lambda actually delivers the event', async () => {
    const emit = await loadEmit()
    await emit(provisioned)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('inits once across multiple emits', async () => {
    const emit = await loadEmit()
    await emit(provisioned)
    await emit(provisioned)
    expect(init).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledTimes(2)
  })

  it('produces a deterministic insert_id across retries of the same event', async () => {
    const emit = await loadEmit()
    await emit(provisioned)
    await emit(provisioned)
    const first = (track.mock.calls[0]?.[0] as Record<string, unknown>)['insert_id']
    const second = (track.mock.calls[1]?.[0] as Record<string, unknown>)['insert_id']
    expect(first).toBe(second)
  })

  it('never throws when the SDK track call throws', async () => {
    track.mockImplementationOnce(() => {
      throw new Error('amplitude blew up')
    })
    const emit = await loadEmit()
    await expect(emit(provisioned)).resolves.toBeUndefined()
  })

  it('never throws when the input is invalid (build/validation failure is swallowed)', async () => {
    const emit = await loadEmit()
    // orgId omitted — buildServerAnalyticsEvent's schema rejects it; the helper must swallow it.
    await expect(
      emit({ identity: { userId } as never, type: 'user_provisioned', payload: { tier: 'free' } }),
    ).resolves.toBeUndefined()
    expect(track).not.toHaveBeenCalled()
  })

  it('is latency-bounded: resolves even when the flush never settles', async () => {
    vi.useFakeTimers()
    try {
      flush.mockReturnValueOnce({ promise: new Promise<void>(() => {}) }) // never resolves
      const emit = await loadEmit()
      const pending = emit(provisioned)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(pending).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
