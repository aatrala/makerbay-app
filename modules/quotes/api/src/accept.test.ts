import { describe, expect, it } from 'vitest'
import {
  affirmationFor,
  documentHash,
  effectiveCheck,
  lastFour,
  snapshotOf,
  verifyAccept,
} from './accept'
import type { QuoteRow } from './db'

/**
 * The accept gate (issue 118). With no email in the loop the link is the whole
 * delivery mechanism, so the check sits on the ACTION: anyone holding the link
 * may read the price, only a verified person may agree to it.
 */

const quote = (over: Partial<QuoteRow> = {}): QuoteRow =>
  ({
    tenantId: 'T1', quoteId: 'Q1', number: 14, contactId: 'C1',
    customerName: 'Marie O\'Brien', customerPhone: '0412 345 678',
    lines: [{ description: 'Tap', unit: 'each', quantity: 2, unitCents: 9500, totalCents: 19000 }],
    subtotalCents: 19000, taxRate: 0.1, taxCents: 1900, totalCents: 20900,
    currency: 'AUD', status: 'sent', publicToken: 'tok', validUntil: '2026-09-26T00:00:00.000Z',
    createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
    ...over,
  }) as QuoteRow

describe('lastFour', () => {
  // The same phone arrives written six different ways.
  it('reads the same four digits whatever the formatting', () => {
    for (const p of ['0412 345 678', '+61 412 345 678', '(04) 1234-5678', '0412345678']) {
      expect(lastFour(p), p).toBe('5678')
    }
  })

  it('gives nothing when there is nothing to compare', () => {
    expect(lastFour(undefined)).toBeUndefined()
    expect(lastFour('')).toBeUndefined()
    expect(lastFour('123')).toBeUndefined()
    expect(lastFour('no digits here')).toBeUndefined()
  })
})

describe('effectiveCheck', () => {
  it('keeps phone4 when there is a number to check against', () => {
    expect(effectiveCheck('phone4', quote())).toBe('phone4')
  })

  // A configured check that locks the customer out is worse than no check.
  it('falls back to name when the quote has no phone', () => {
    expect(effectiveCheck('phone4', quote({ customerPhone: undefined }))).toBe('name')
    expect(effectiveCheck('phone4', quote({ customerPhone: 'n/a' }))).toBe('name')
  })

  it('leaves the other modes alone', () => {
    expect(effectiveCheck('name', quote())).toBe('name')
    expect(effectiveCheck('none', quote())).toBe('none')
  })
})

describe('verifyAccept', () => {
  it('lets a typed name through', () => {
    expect(verifyAccept('name', quote(), { name: 'Marie O\'Brien' })).toBeUndefined()
  })

  it('refuses an empty name, because a bare tap is anonymous', () => {
    expect(verifyAccept('name', quote(), {})?.error).toBe('name_required')
    expect(verifyAccept('name', quote(), { name: '   ' })?.error).toBe('name_required')
  })

  it('refuses a single character, which is not a signature', () => {
    expect(verifyAccept('name', quote(), { name: 'M' })?.error).toBe('name_too_short')
  })

  /**
   * Deliberate: quotes made out to "Marie" get accepted by her husband, and
   * quotes to a company by whoever runs it. Rejecting those blocks real,
   * willing customers to prevent nothing, since anyone holding the link could
   * read the name off the page and type it back.
   */
  it('does NOT require the typed name to match the one on the quote', () => {
    expect(verifyAccept('name', quote(), { name: 'David O\'Brien' })).toBeUndefined()
    expect(verifyAccept('name', quote(), { name: 'Brightwork Pty Ltd' })).toBeUndefined()
  })

  it('skips everything when the check is off', () => {
    expect(verifyAccept('none', quote(), {})).toBeUndefined()
  })

  describe('phone4', () => {
    it('accepts the right four digits alongside a name', () => {
      expect(verifyAccept('phone4', quote(), { name: 'Marie', phone4: '5678' })).toBeUndefined()
    })

    it('ignores how the customer types them', () => {
      expect(verifyAccept('phone4', quote(), { name: 'Marie', phone4: ' 5678 ' })).toBeUndefined()
      expect(verifyAccept('phone4', quote(), { name: 'Marie', phone4: '56-78' })).toBeUndefined()
    })

    it('refuses the wrong digits', () => {
      expect(verifyAccept('phone4', quote(), { name: 'Marie', phone4: '1234' })?.error)
        .toBe('phone4_mismatch')
    })

    it('refuses when they are missing', () => {
      expect(verifyAccept('phone4', quote(), { name: 'Marie' })?.error).toBe('phone4_mismatch')
    })

    // The name is still the signature, so it is checked first either way.
    it('still requires the name', () => {
      expect(verifyAccept('phone4', quote(), { phone4: '5678' })?.error).toBe('name_required')
    })

    // A quote can lose its phone between share and accept. Locking the
    // customer out of a document they were sent is the worse failure.
    it('degrades rather than locking the customer out with nothing to match', () => {
      expect(verifyAccept('phone4', quote({ customerPhone: undefined }), { name: 'Marie' }))
        .toBeUndefined()
    })
  })
})

describe('documentHash', () => {
  it('is stable for the same figures', () => {
    expect(documentHash(snapshotOf(quote()))).toBe(documentHash(snapshotOf(quote())))
  })

  /**
   * The point of the hash: it must be reproducible by whoever is checking it,
   * and JavaScript's key order is not something a third party can replicate.
   */
  it('ignores key order, so the party checking it can reproduce it', () => {
    const a = { totalCents: 20900, currency: 'AUD', taxRate: 0.1 } as never
    const b = { taxRate: 0.1, currency: 'AUD', totalCents: 20900 } as never
    expect(documentHash(a)).toBe(documentHash(b))
  })

  it('changes when any figure changes', () => {
    const base = documentHash(snapshotOf(quote()))
    expect(documentHash(snapshotOf(quote({ totalCents: 20901 })))).not.toBe(base)
    expect(documentHash(snapshotOf(quote({ taxRate: 0.2 })))).not.toBe(base)
    expect(documentHash(snapshotOf(quote({ currency: 'NZD' })))).not.toBe(base)
    expect(documentHash(snapshotOf(quote({ validUntil: '2027-01-01T00:00:00.000Z' })))).not.toBe(base)
  })

  it('changes when a line changes, not just the total', () => {
    const base = documentHash(snapshotOf(quote()))
    const relabelled = quote({
      lines: [{ description: 'Different tap', unit: 'each', quantity: 2, unitCents: 9500, totalCents: 19000 }],
    })
    expect(documentHash(snapshotOf(relabelled))).not.toBe(base)
  })

  it('changes when the terms change, because those are what was agreed to', () => {
    const base = documentHash(snapshotOf(quote()))
    expect(documentHash(snapshotOf(quote({ terms: 'Payment up front.' })))).not.toBe(base)
  })

  it('is a sha-256 hex digest', () => {
    expect(documentHash(snapshotOf(quote()))).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('snapshotOf', () => {
  it('freezes the figures the customer was looking at', () => {
    const s = snapshotOf(quote())
    expect(s).toMatchObject({ totalCents: 20900, taxCents: 1900, currency: 'AUD' })
    expect(s.lines).toHaveLength(1)
  })

  // Nothing about who they are: the record is about the transaction.
  it('carries no customer identity', () => {
    const s = JSON.stringify(snapshotOf(quote()))
    expect(s).not.toContain('Marie')
    expect(s).not.toContain('5678')
  })
})

describe('affirmationFor', () => {
  it('names the business and the amount, so what was agreed is unambiguous', () => {
    const a = affirmationFor('Dunn Plumbing', '$209.00')
    expect(a).toContain('Dunn Plumbing')
    expect(a).toContain('$209.00')
  })
})
