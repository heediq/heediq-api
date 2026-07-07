import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDynamoSend = vi.hoisted(() => vi.fn())

vi.mock('../config.js', () => ({
  config: { dynamo: { rateLimitsTable: 'heediq-rate-limits' } },
}))

vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: mockDynamoSend } }))

import { checkRateLimit } from '../lib/rateLimit.js'

describe('checkRateLimit (D-097)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('allows a request under the limit', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Attributes: { count: 3 } })
    const limited = await checkRateLimit('REQUEST_OTP', 'EMAIL', 'a@b.com', 5, 900)
    expect(limited).toBe(false)
  })

  it('blocks a request once the count exceeds the limit', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Attributes: { count: 6 } })
    const limited = await checkRateLimit('REQUEST_OTP', 'EMAIL', 'a@b.com', 5, 900)
    expect(limited).toBe(true)
  })

  it('does not block a request exactly at the limit', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Attributes: { count: 5 } })
    const limited = await checkRateLimit('REQUEST_OTP', 'EMAIL', 'a@b.com', 5, 900)
    expect(limited).toBe(false)
  })

  it('uses independent counters for different key types on the same value', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Attributes: { count: 1 } })
    await checkRateLimit('REQUEST_OTP', 'EMAIL', 'shared', 5, 900)
    const [call] = mockDynamoSend.mock.calls[0] as [{ input: { Key: { pk: string } } }]
    expect(call.input.Key.pk).toContain('EMAIL#shared')
  })

  it('uses independent counters per route', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Attributes: { count: 1 } })
    await checkRateLimit('VERIFY_OTP', 'IP', '1.2.3.4', 10, 60)
    const [call] = mockDynamoSend.mock.calls[0] as [{ input: { Key: { pk: string } } }]
    expect(call.input.Key.pk).toContain('VERIFY_OTP#IP#1.2.3.4')
  })
})
