/**
 * Money formatting for a product sold wherever Stripe works (issue 114).
 *
 * Integer minor units everywhere. No float ever touches a price.
 *
 * The bug this exists to fix: every formatter in the codebase was pinned to
 * `en-AU`, and Intl deliberately disambiguates a foreign currency for the
 * reader's locale. So a London electrician quoting in GBP was shown
 * "GBP 99.00", and a Toronto plumber "CA$99.00", on their own invoice, to
 * their own customer. It looks like a bug in their business, not in ours.
 *
 * The fix is not to drop the locale - `undefined` resolves to whatever the
 * Lambda runtime happens to be, which is US English, so AUD would render as
 * "A$99.00" for an Australian. It is to render each currency the way the
 * country that uses it renders it.
 */

/**
 * The English-speaking locale that treats each currency as local, so the
 * symbol appears bare: "$99.00", "£99.00", never "GBP 99.00".
 *
 * English throughout on purpose. The product is English-only today, and a
 * German locale for EUR would move the symbol after the number and swap the
 * separators, which would look broken next to English copy.
 */
const LOCALE: Record<string, string> = {
  AUD: 'en-AU',
  NZD: 'en-NZ',
  GBP: 'en-GB',
  USD: 'en-US',
  CAD: 'en-CA',
  EUR: 'en-IE',
  INR: 'en-IN',
  SGD: 'en-SG',
  ZAR: 'en-ZA',
  AED: 'en-AE',
}

/** Every currency the quotes screen offers. Keep in step with that list. */
export const CURRENCIES = Object.keys(LOCALE)

export const localeForCurrency = (currency: string): string =>
  LOCALE[String(currency).toUpperCase()] ?? 'en'

/**
 * Where a workspace's money settings come from when nobody has chosen yet.
 *
 * Derived from the browser's region at signup, the same way the timezone
 * already is. A hardcoded default is wrong for most of the world and, worse,
 * "AUD" looks deliberate enough that a UK tradesperson assumes it is meant to
 * be there and quotes in it by accident.
 */
const REGION_CURRENCY: Record<string, string> = {
  AU: 'AUD', NZ: 'NZD', GB: 'GBP', UK: 'GBP', US: 'USD', CA: 'CAD',
  IN: 'INR', SG: 'SGD', ZA: 'ZAR', AE: 'AED',
  IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR',
  AT: 'EUR', BE: 'EUR', PT: 'EUR', FI: 'EUR',
}

/**
 * Best guess at a currency from a BCP-47 locale such as `en-GB`.
 *
 * Returns undefined rather than a fallback when there is no confident answer:
 * an unset currency can be asked about, but a wrong one that looks deliberate
 * gets quoted in.
 */
export function currencyForLocale(locale?: string): string | undefined {
  if (!locale) return undefined
  // The region subtag, which is the only part that carries the answer.
  // `en-GB` -> GB. `en` alone tells us nothing: English is not a country.
  const region = String(locale).toUpperCase().split(/[-_]/).slice(1)
    .find((p) => /^[A-Z]{2}$/.test(p))
  return region ? REGION_CURRENCY[region] : undefined
}

/**
 * Format an amount in minor units.
 *
 * Never throws: an unknown currency code falls back to a plain number rather
 * than taking down the page that was trying to show a price.
 *
 * `trimEvenCents` drops the ".00" from round amounts - for marketing surfaces
 * like the public business page, where "$80" reads better than "$80.00".
 * Documents keep the cents: an invoice total is a figure, not a headline.
 */
export const money = (
  cents: number,
  currency = 'AUD',
  opts?: { trimEvenCents?: boolean },
): string => {
  const code = String(currency ?? 'AUD').toUpperCase()
  const trim = opts?.trimEvenCents === true && cents % 100 === 0
  try {
    return new Intl.NumberFormat(localeForCurrency(code), {
      style: 'currency',
      currency: code,
      ...(trim ? { minimumFractionDigits: 0 } : {}),
    }).format(cents / 100)
  } catch {
    return `${code} ${(cents / 100).toFixed(trim ? 0 : 2)}`
  }
}

/** Line total, rounded once, so a hand-added column matches the invoice. */
export const lineTotalCents = (quantity: number, unitCents: number): number =>
  Math.round(quantity * unitCents)
