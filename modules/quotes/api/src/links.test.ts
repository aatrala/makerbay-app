import { describe, expect, it } from 'vitest'
import { docUrl, parseDocPath } from './links'

/**
 * The address a homeowner reads in a WhatsApp message from a number they may
 * not recognise (issue 118 phase 2). Before this it was
 * chat.makerbay.app/quote?slug=…&token=… and the preview card said "Chat".
 */

describe('docUrl', () => {
  const TOKEN = 'IdC_9xKq2mVvA1sPzR7bWnLe'

  it('puts the kind in the host, so it reads first', () => {
    expect(docUrl('quote', 'dunn-plumbing', 'Q-014', TOKEN))
      .toBe(`https://quote.makerbay.app/dunn-plumbing/Q-014/${TOKEN}`)
    expect(docUrl('invoice', 'dunn-plumbing', 'INV-042', TOKEN))
      .toBe(`https://invoice.makerbay.app/dunn-plumbing/INV-042/${TOKEN}`)
  })

  // `?` and `&` are what make SMS and older mail clients truncate a URL.
  it('has no query string at all', () => {
    const url = docUrl('quote', 'dunn-plumbing', 'Q-014', TOKEN)
    expect(url).not.toContain('?')
    expect(url).not.toContain('&')
    expect(url).not.toContain('=')
  })

  // It goes into a 160-character SMS alongside a sentence.
  it('is shorter than the query-string form it replaces', () => {
    const now = docUrl('quote', 'dunn-plumbing', 'Q-014', TOKEN)
    const before = `https://chat.makerbay.app/quote?slug=dunn-plumbing&token=${TOKEN}`
    expect(now.length).toBeLessThan(before.length)
    expect(now.length).toBeLessThan(90)
  })

  it('carries no timestamp and no internal id', () => {
    const url = docUrl('quote', 'dunn-plumbing', 'Q-014', TOKEN)
    // A ULID would be 26 chars of uppercase and digits; a timestamp 10+ digits.
    expect(url).not.toMatch(/\d{10,}/)
    expect(url).not.toMatch(/[0-9A-Z]{26}/)
  })

  // Slugs and labels are validated, but encoding at the boundary is what stops
  // the next field that reaches this function from being the one that breaks.
  it('encodes every segment', () => {
    const url = docUrl('quote', 'a b', 'Q/014', TOKEN)
    expect(url).toBe(`https://quote.makerbay.app/a%20b/Q%2F014/${TOKEN}`)
    // The forged separator must not survive as a path separator.
    expect(url.split('/').length).toBe(6)
  })

  it('keeps the token byte for byte, because it is the whole authorisation', () => {
    const tricky = 'a-b_c-D_9xKq2mVvA1sPzR7b'
    expect(docUrl('quote', 's', 'L', tricky).endsWith(`/${tricky}`)).toBe(true)
  })
})

describe('parseDocPath', () => {
  it('reads back what docUrl wrote', () => {
    const url = new URL(docUrl('quote', 'dunn-plumbing', 'Q-014', 'TOKEN123456789012345678'))
    expect(parseDocPath(url.pathname)).toEqual({
      slug: 'dunn-plumbing', label: 'Q-014', token: 'TOKEN123456789012345678',
    })
  })

  it('survives a trailing or doubled slash', () => {
    expect(parseDocPath('/dunn-plumbing/Q-014/TOK/')?.token).toBe('TOK')
    expect(parseDocPath('//dunn-plumbing//Q-014//TOK')?.token).toBe('TOK')
  })

  it('decodes what was encoded', () => {
    expect(parseDocPath('/a%20b/Q-014/TOK')?.slug).toBe('a b')
  })

  // Guessing on a short path would mean treating a label as a token.
  it('returns nothing rather than guessing', () => {
    expect(parseDocPath('/dunn-plumbing')).toBeUndefined()
    expect(parseDocPath('/dunn-plumbing/Q-014')).toBeUndefined()
    expect(parseDocPath('/')).toBeUndefined()
    expect(parseDocPath('')).toBeUndefined()
  })
})
