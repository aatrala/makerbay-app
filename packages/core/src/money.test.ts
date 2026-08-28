import { describe, expect, it } from 'vitest'
import { currencyForLocale, localeForCurrency, money } from './money'

/**
 * MakerBay is sold wherever Stripe works, but every formatter was pinned to
 * en-AU. Intl deliberately disambiguates a foreign currency for the reader's
 * locale, so a London electrician was shown "GBP 99.00" and a Toronto plumber
 * "CA$99.00" on their own invoice, to their own customer (issue 114).
 */

describe('money', () => {
  // The defect, stated as the requirement. Exactly how Intl disambiguated was
  // ICU-version dependent, so this asserts the fix rather than the old output.
  it('shows a bare symbol for every currency we offer', () => {
    expect(money(9900, 'GBP')).toBe('£99.00')
    expect(money(9900, 'USD')).toBe('$99.00')
    expect(money(9900, 'AUD')).toBe('$99.00')
    expect(money(9900, 'CAD')).toBe('$99.00')
    expect(money(9900, 'NZD')).toBe('$99.00')
    expect(money(9900, 'EUR')).toBe('€99.00')
  })

  it('never renders a currency code where a symbol exists', () => {
    // AED is excluded on purpose: the dirham has no Latin symbol, so
    // "AED 99.00" IS how a UAE business writes it in English. Asserting a
    // symbol for it would be asserting a bug.
    for (const c of ['AUD', 'NZD', 'GBP', 'USD', 'CAD', 'EUR', 'INR', 'SGD', 'ZAR']) {
      expect(money(9900, c), c).not.toMatch(/[A-Z]{3}/)
    }
    // Intl separates with a non-breaking space, which is correct and must
    // not be normalised away by a display layer later.
    expect(money(9900, 'AED')).toBe('AED 99.00')
  })

  // Correct South African formatting: R prefix, comma decimal separator.
  // Pinned so nobody "fixes" it into something an en-AU reader finds familiar.
  it("uses each country's own separators, not ours", () => {
    expect(money(9900, 'ZAR')).toBe('R 99,00')
  })

  it('is case insensitive about the code', () => {
    expect(money(9900, 'gbp')).toBe(money(9900, 'GBP'))
  })

  it('keeps minor units exact, because a rounded price is a wrong price', () => {
    expect(money(1, 'USD')).toBe('$0.01')
    expect(money(99, 'USD')).toBe('$0.99')
    expect(money(123456, 'USD')).toBe('$1,234.56')
    expect(money(0, 'USD')).toBe('$0.00')
  })

  // Falling over on a bad code would take down the page trying to show a price.
  it('falls back rather than throwing on an unknown code', () => {
    expect(() => money(9900, 'ZZZ')).not.toThrow()
    expect(money(9900, 'ZZZ')).toContain('99.00')
  })

  it('defaults to a locale rather than crashing on an unmapped currency', () => {
    expect(localeForCurrency('JPY')).toBe('en')
    expect(localeForCurrency('GBP')).toBe('en-GB')
  })
})

describe('currencyForLocale', () => {
  it('reads the region a browser actually reports', () => {
    expect(currencyForLocale('en-GB')).toBe('GBP')
    expect(currencyForLocale('en-AU')).toBe('AUD')
    expect(currencyForLocale('en-US')).toBe('USD')
    expect(currencyForLocale('en-CA')).toBe('CAD')
    expect(currencyForLocale('en-NZ')).toBe('NZD')
    expect(currencyForLocale('en-IN')).toBe('INR')
    expect(currencyForLocale('en-IE')).toBe('EUR')
  })

  // "en" is a language, not a country. Guessing from it is how everyone
  // English-speaking ended up on AUD in the first place.
  it('returns nothing when the locale carries no region', () => {
    expect(currencyForLocale('en')).toBeUndefined()
    expect(currencyForLocale('')).toBeUndefined()
    expect(currencyForLocale(undefined)).toBeUndefined()
  })

  it('returns nothing for a region we have no confident answer for', () => {
    expect(currencyForLocale('en-ZW')).toBeUndefined()
  })

  it('handles the underscore form and odd casing', () => {
    expect(currencyForLocale('en_GB')).toBe('GBP')
    expect(currencyForLocale('en-gb')).toBe('GBP')
  })

  it('reads the region past a script subtag', () => {
    expect(currencyForLocale('zh-Hans-SG')).toBe('SGD')
  })

  // The round trip that matters: detect at signup, then format with it.
  it('produces a currency that formats to a bare symbol', () => {
    for (const l of ['en-GB', 'en-US', 'en-AU', 'en-CA', 'en-NZ', 'en-IE']) {
      const c = currencyForLocale(l)
      expect(c, l).toBeDefined()
      expect(money(9900, c!), `${l} -> ${c}`).not.toMatch(/[A-Z]{3}/)
    }
  })
})
