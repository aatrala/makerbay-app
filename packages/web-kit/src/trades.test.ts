import { describe, expect, it } from 'vitest'
import { tradeExamples } from './trades'

/**
 * The trade has been collected at signup since issue 83 and read by nothing
 * until issue 143, so every business saw the same placeholders: a salon was
 * shown "Labour, qualified electrician" and a plumber was shown salon prices.
 *
 * These tests are about the property, not the wording. The examples are the
 * founder's to change; "a salon is never shown an electrician" is a rule.
 */

describe('trade examples', () => {
  it('matches loosely, because the trade is free text', () => {
    for (const t of ['Plumbing', 'plumber', 'Plumbing & gas fitting', 'PLUMBING']) {
      expect(tradeExamples(t).quoteLine, t).toContain('plumber')
    }
  })

  it('never shows one trade the language of another', () => {
    expect(tradeExamples('Salon & beauty').quoteLine).not.toMatch(/electric|plumb/i)
    expect(tradeExamples('Plumbing').service).not.toMatch(/cut|blow dry|facial/i)
    expect(tradeExamples('Tutoring & coaching').quoteLine).not.toMatch(/electric|plumb|groom/i)
  })

  it('falls back to something trade-free rather than to somebody else\'s trade', () => {
    for (const t of [undefined, '', 'Other', 'Underwater basket weaving']) {
      const eg = tradeExamples(t)
      expect(eg.quoteLine, String(t)).not.toMatch(/electric|plumb|salon|groom|paint/i)
      expect(eg.service, String(t)).toBeTruthy()
    }
  })

  /**
   * A licence line is a compliance field. Suggesting the wrong licence to
   * somebody filling in their legal footer is worse than suggesting nothing,
   * so the neutral fallback must not name a trade licence either.
   */
  it('never suggests a licence a business may not hold', () => {
    expect(tradeExamples('Other').docFooter).not.toMatch(/plumbing|electrical|builder/i)
    expect(tradeExamples('Salon & beauty').docFooter).not.toMatch(/licence/i)
  })

  it('gives every field a usable value for every listed trade', () => {
    const listed = [
      'Plumbing', 'Electrical', 'Cleaning', 'Landscaping & gardening',
      'Building & carpentry', 'Handyman', 'Painting', 'HVAC & refrigeration',
      'Salon & beauty', 'Tutoring & coaching', 'Pet services', 'Other',
    ]
    for (const t of listed) {
      const eg = tradeExamples(t)
      for (const [k, v] of Object.entries(eg)) {
        expect(v, `${t}.${k}`).toBeTruthy()
      }
      // Prices are typed into a number field; a placeholder that is not a
      // plausible amount teaches the wrong format.
      expect(eg.servicePrice, t).toMatch(/^\d+\.\d{2}$/)
      expect(eg.deposit, t).toMatch(/^\d+\.\d{2}$/)
    }
  })
})
