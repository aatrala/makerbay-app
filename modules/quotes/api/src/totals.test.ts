import { describe, expect, it } from 'vitest'
import { computeTotals, effectiveStatus, isExpired, type QuoteRow } from './db'

describe('computeTotals', () => {
  it('sums whole-dollar lines exactly', () => {
    const t = computeTotals({
      lines: [{ quantity: 2, unitCents: 15000 }, { quantity: 1, unitCents: 5000 }],
      taxRate: 0,
    })
    expect(t.lineTotals).toEqual([30000, 5000])
    expect(t.subtotalCents).toBe(35000)
    expect(t.totalCents).toBe(35000)
  })

  it('rounds each line once, so a hand-added column matches', () => {
    // 3 x $10.005 rounds per line to 1001, 1001, 1001 = 3003.
    // Rounding the product instead would give 3002 and the customer would be
    // able to add the column up and get a different answer to ours.
    const t = computeTotals({ lines: [
      { quantity: 1, unitCents: 1000.5 },
      { quantity: 1, unitCents: 1000.5 },
      { quantity: 1, unitCents: 1000.5 },
    ], taxRate: 0 })
    expect(t.lineTotals).toEqual([1001, 1001, 1001])
    expect(t.subtotalCents).toBe(3003)
  })

  it('handles fractional quantities like hours', () => {
    const t = computeTotals({ lines: [{ quantity: 2.5, unitCents: 9000 }], taxRate: 0 })
    expect(t.lineTotals).toEqual([22500])
  })

  it('applies tax as a fraction of the subtotal', () => {
    const t = computeTotals({ lines: [{ quantity: 1, unitCents: 10000 }], taxRate: 0.1 })
    expect(t.taxCents).toBe(1000)
    expect(t.totalCents).toBe(11000)
  })

  it('rounds tax to whole cents', () => {
    const t = computeTotals({ lines: [{ quantity: 1, unitCents: 3333 }], taxRate: 0.1 })
    expect(t.taxCents).toBe(333)
    expect(t.totalCents).toBe(3666)
  })

  it('never produces negative tax from a negative rate', () => {
    const t = computeTotals({ lines: [{ quantity: 1, unitCents: 10000 }], taxRate: -0.5 })
    expect(t.taxCents).toBe(0)
  })

  it('totals an empty quote as zero rather than NaN', () => {
    const t = computeTotals({ lines: [], taxRate: 0.1 })
    expect(t).toEqual({ lineTotals: [], subtotalCents: 0, taxCents: 0, totalCents: 0 })
  })
})

const quote = (over: Partial<QuoteRow> = {}): QuoteRow => ({
  tenantId: 't', quoteId: 'q', number: 1, contactId: 'c',
  lines: [], subtotalCents: 0, taxRate: 0, taxCents: 0, totalCents: 0,
  currency: 'AUD', status: 'sent', publicToken: 'tok',
  validUntil: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
})

describe('expiry', () => {
  const after = new Date('2026-09-02T00:00:00Z')
  const during = new Date('2026-08-20T00:00:00Z')

  it('expires a sent quote past its date', () => {
    expect(isExpired(quote(), after)).toBe(true)
    expect(effectiveStatus(quote(), after)).toBe('expired')
  })

  it('leaves a sent quote alone before its date', () => {
    expect(effectiveStatus(quote(), during)).toBe('sent')
  })

  it('never expires an accepted quote — the price was already agreed', () => {
    expect(effectiveStatus(quote({ status: 'accepted' }), after)).toBe('accepted')
  })

  it('never expires a draft, which was never offered to anyone', () => {
    expect(effectiveStatus(quote({ status: 'draft' }), after)).toBe('draft')
  })

  it('leaves a declined quote declined', () => {
    expect(effectiveStatus(quote({ status: 'declined' }), after)).toBe('declined')
  })
})
