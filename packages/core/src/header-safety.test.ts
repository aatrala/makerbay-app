import { describe, expect, it } from 'vitest'
import { headerSafe } from './notify'

/**
 * A business name is attacker-controlled text that reaches a mail header and
 * lands in a stranger's inbox on a domain we authenticate. Harmless under
 * Content.Simple; header injection under Raw, which List-Unsubscribe needs.
 */
describe('headerSafe', () => {
  it('strips the CRLF that would inject a header', () => {
    expect(headerSafe('Acme Plumbing\r\nBcc: attacker@evil.com'))
      .toBe('Acme Plumbing Bcc: attacker@evil.com')
    expect(headerSafe('Acme\nBcc: x@y.com')).not.toContain('\n')
    expect(headerSafe('Acme\rBcc: x@y.com')).not.toContain('\r')
  })

  it('leaves an ordinary business name alone', () => {
    expect(headerSafe("O'Brien & Sons Plumbing")).toBe("O'Brien & Sons Plumbing")
  })

  it('collapses runs of whitespace rather than preserving layout', () => {
    expect(headerSafe('Acme    Plumbing')).toBe('Acme Plumbing')
    expect(headerSafe('  Acme  ')).toBe('Acme')
  })

  it('caps length so one tenant cannot blow out a header', () => {
    expect(headerSafe('x'.repeat(500))).toHaveLength(78)
  })

  it('survives the values that reach it in practice', () => {
    expect(headerSafe(undefined as unknown as string)).toBe('')
    expect(headerSafe('')).toBe('')
  })
})
