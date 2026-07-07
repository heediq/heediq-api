import { describe, it, expect, vi, beforeEach } from 'vitest'

const send = vi.fn()
vi.mock('../lib/dynamo.js', () => ({ dynamo: { send: (...args: unknown[]) => send(...args) } }))

const { resolveAccountIdBySub, resolveAccountIdByEmail, linkIdentity } = await import('../lib/accountIdentity.js')

describe('accountIdentity', () => {
  beforeEach(() => { send.mockReset() })

  describe('resolveAccountIdBySub', () => {
    it('returns the accountId when the identities table has a mapping', async () => {
      send.mockResolvedValueOnce({ Item: { sub: 'sub-1', accountId: 'account-1' } })

      const result = await resolveAccountIdBySub('heediq-cognito-identities', 'sub-1')

      expect(result).toBe('account-1')
      expect(send).toHaveBeenCalledTimes(1)
      const call = send.mock.calls[0]?.[0] as { input: { TableName: string; Key: Record<string, unknown> } }
      expect(call.input.TableName).toBe('heediq-cognito-identities')
      expect(call.input.Key).toEqual({ sub: 'sub-1' })
    })

    it('returns undefined when there is no mapping for the sub', async () => {
      send.mockResolvedValueOnce({ Item: undefined })

      const result = await resolveAccountIdBySub('heediq-cognito-identities', 'unknown-sub')

      expect(result).toBeUndefined()
    })
  })

  describe('linkIdentity', () => {
    it('writes a sub -> accountId mapping with a linkedAt timestamp', async () => {
      send.mockResolvedValueOnce({})

      await linkIdentity('heediq-cognito-identities', 'sub-1', 'account-1')

      expect(send).toHaveBeenCalledTimes(1)
      const call = send.mock.calls[0]?.[0] as { input: { TableName: string; Item: Record<string, unknown> } }
      expect(call.input.TableName).toBe('heediq-cognito-identities')
      expect(call.input.Item['sub']).toBe('sub-1')
      expect(call.input.Item['accountId']).toBe('account-1')
      expect(typeof call.input.Item['linkedAt']).toBe('string')
    })
  })

  describe('resolveAccountIdByEmail', () => {
    it('returns the userId of the first match from the by-email GSI', async () => {
      send.mockResolvedValueOnce({ Items: [{ userId: 'account-1', email: 'a@b.com' }] })

      const result = await resolveAccountIdByEmail('heediq-users', 'a@b.com')

      expect(result).toBe('account-1')
      const call = send.mock.calls[0]?.[0] as {
        input: { TableName: string; IndexName: string; ExpressionAttributeValues: Record<string, unknown>; Limit: number }
      }
      expect(call.input.TableName).toBe('heediq-users')
      expect(call.input.IndexName).toBe('by-email')
      expect(call.input.ExpressionAttributeValues).toEqual({ ':email': 'a@b.com' })
      expect(call.input.Limit).toBe(1)
    })

    it('returns undefined when no row matches the email', async () => {
      send.mockResolvedValueOnce({ Items: [] })

      const result = await resolveAccountIdByEmail('heediq-users', 'nobody@b.com')

      expect(result).toBeUndefined()
    })
  })
})
