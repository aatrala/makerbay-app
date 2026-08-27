import { describe, expect, it } from 'vitest'
import { authEmail, CODE_PLACEHOLDER } from './auth'

/**
 * These carry the anti-phishing promise, so the properties below are the
 * product, not decoration.
 */
const KINDS = ['verify', 'reset', 'signin'] as const

describe('auth emails', () => {
  it('keeps Cognito\'s placeholder intact in subject, HTML and text', () => {
    for (const k of KINDS) {
      const e = authEmail(k)
      expect(e.subject, k).toContain(CODE_PLACEHOLDER)
      expect(e.html, k).toContain(CODE_PLACEHOLDER)
      expect(e.text, k).toContain(CODE_PLACEHOLDER)
    }
  })

  it('fits Cognito\'s 140-character subject and 20,000-character body limits', () => {
    for (const k of KINDS) {
      const e = authEmail(k)
      expect(e.subject.length, k).toBeLessThanOrEqual(140)
      expect(e.html.length, k).toBeLessThanOrEqual(20_000)
    }
  })

  it('puts the code in the subject, so it reads off a lock screen', () => {
    for (const k of KINDS) expect(authEmail(k).subject.startsWith(CODE_PLACEHOLDER), k).toBe(true)
  })

  // The one that matters most. A code email with a button means a spoofed
  // code email with a button is indistinguishable.
  it('contains no link at all', () => {
    for (const k of KINDS) {
      const e = authEmail(k)
      expect(e.html, k).not.toMatch(/<a\s/i)
      expect(e.html, k).not.toContain('href=')
    }
  })

  it('names all three channels an attacker could use', () => {
    for (const k of KINDS) {
      expect(authEmail(k).text.replace(/\s+/g, ' '), k).toContain('phone, text or email')
    }
  })

  it('offers no unsubscribe or preference link, which would be a phishing vector', () => {
    for (const k of KINDS) {
      expect(authEmail(k).text, k).not.toContain('settings/notifications')
    }
  })

  it('tells someone who did not ask for it that nothing has happened', () => {
    // Collapse the wrapping first: the property is that the copy says this,
    // not that it lands on one line.
    const flat = (k: 'verify' | 'reset' | 'signin') =>
      authEmail(k).text.replace(/\s+/g, ' ')
    expect(flat('verify')).toContain('no account exists yet')
    expect(flat('reset')).toContain('has not been changed')
    expect(flat('signin')).toContain('cannot get in without the code')
  })

  it('gives sign-in a shorter life than the others', () => {
    expect(authEmail('signin').text).toContain('10 minutes')
    expect(authEmail('verify').text).toContain('15 minutes')
  })
})
