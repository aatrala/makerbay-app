import { describe, expect, it } from 'vitest'
import { hasScope, requireScope } from './http'

/**
 * The property that matters: this is additive. Every caller that worked
 * before it existed must still work, or shipping it breaks the product.
 */
describe('requireScope', () => {
  it("lets '*' through, so secret keys and Cognito sessions are unchanged", () => {
    expect(requireScope({ scopes: '*' }, 'booking:services:write')).toBeUndefined()
    expect(requireScope({ scopes: '*' }, 'presence:page:write')).toBeUndefined()
  })

  it('lets a caller through on exactly the scope it holds', () => {
    expect(requireScope({ scopes: 'presence:page:write' }, 'presence:page:write')).toBeUndefined()
  })

  it('refuses a caller that holds a different scope', () => {
    const denied = requireScope({ scopes: 'presence:page:write' }, 'booking:services:write')
    expect(denied?.statusCode).toBe(403)
    expect(JSON.parse(denied!.body).required).toBe('booking:services:write')
  })

  it('reads a comma-separated list, with or without spaces', () => {
    const ctx = { scopes: 'presence:page:write, booking:config:write' }
    expect(hasScope(ctx, 'booking:config:write')).toBe(true)
    expect(hasScope(ctx, 'booking:services:write')).toBe(false)
  })

  it('refuses an empty or malformed scope string rather than defaulting open', () => {
    for (const scopes of ['', '   ', ',,,']) {
      expect(requireScope({ scopes }, 'presence:page:write')?.statusCode).toBe(403)
    }
  })

  it('does not match on a prefix', () => {
    expect(hasScope({ scopes: 'presence:page' }, 'presence:page:write')).toBe(false)
    expect(hasScope({ scopes: 'presence' }, 'presence:page:write')).toBe(false)
  })
})
