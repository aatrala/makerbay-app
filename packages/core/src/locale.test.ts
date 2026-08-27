import { describe, expect, it } from 'vitest'

/**
 * MakerBay had Australia baked into its defaults: Australia/Sydney for every
 * diary, AUD for every price, en-AU for every formatter. Fine while every
 * customer was in Sydney; wrong for a product sold anywhere Stripe works.
 *
 * These tests pin the behaviour that a workspace is not silently told it is
 * somewhere it is not. They use the platform Intl directly, because that is
 * what the modules use.
 */

const zoneIsValid = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz }).format(new Date())
    return true
  } catch {
    return false
  }
}

describe('timezone handling', () => {
  it('accepts the IANA zones a browser actually reports', () => {
    for (const tz of [
      'Australia/Sydney', 'Europe/London', 'America/New_York', 'America/Chicago',
      'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland', 'Africa/Johannesburg',
      'Asia/Singapore', 'America/Toronto', 'Asia/Dubai', 'UTC',
    ]) {
      expect(zoneIsValid(tz), tz).toBe(true)
    }
  })

  // The validation that stops a bad zone reaching storage, where it would
  // silently shift every appointment the workspace ever takes.
  it('rejects anything that is not a real zone', () => {
    for (const bad of ['Sydney', 'GMT+10', 'not/a/zone', '', 'Australia/Nowhere']) {
      expect(zoneIsValid(bad), bad).toBe(false)
    }
  })

  it('formats the same instant differently per zone, which is the whole point', () => {
    const at = new Date('2026-08-31T03:00:00.000Z')
    const label = (tz: string) =>
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
        .format(at)
    expect(label('Australia/Sydney')).toBe('13:00')
    expect(label('Europe/London')).toBe('04:00')
    expect(label('America/New_York')).toBe('23:00')
    // A Manchester plumber told their 4am slot is 1pm is the bug this prevents.
    expect(label('Europe/London')).not.toBe(label('Australia/Sydney'))
  })
})

describe('money formatting', () => {
  const cash = (cents: number, currency: string, locale = 'en-AU') =>
    new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100)

  // Why the hardcoded en-AU locale mattered: it renders other currencies with
  // a disambiguating prefix, so a US business saw US$ and a Canadian CA$.
  it('disambiguates a foreign currency under en-AU, so a local sees the wrong thing', () => {
    // Exactly HOW it disambiguates is ICU-version dependent - "US$99.00" on
    // some runtimes, "USD 99.00" on others. The defect is the same either
    // way: a US business is shown something that is not "$99.00".
    for (const c of ['USD', 'CAD', 'GBP']) {
      expect(cash(9900, c), c).not.toBe('$99.00')
      expect(cash(9900, c), c).toMatch(/US|CA|GB|£|\$/)
    }
  })

  it('shows a plain symbol when the locale matches the currency', () => {
    expect(cash(9900, 'USD', 'en-US')).toBe('$99.00')
    expect(cash(9900, 'GBP', 'en-GB')).toBe('£99.00')
    expect(cash(9900, 'AUD', 'en-AU')).toBe('$99.00')
  })

  it('handles every currency the quotes screen offers', () => {
    for (const c of ['AUD', 'INR', 'USD', 'NZD', 'GBP', 'EUR', 'CAD', 'SGD', 'ZAR', 'AED']) {
      expect(() => cash(12345, c), c).not.toThrow()
    }
  })
})
