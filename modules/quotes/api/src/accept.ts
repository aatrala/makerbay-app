import { createHash } from 'node:crypto'
import type { AcceptCheck, AcceptanceSnapshot, QuoteRow } from './db'

/**
 * What turns a tap into an acceptance (issue 118).
 *
 * With no email in the loop, the link is the whole delivery mechanism, and
 * anyone it was forwarded to can open it. That is fine for reading a price and
 * not fine for agreeing to one, so the check sits on the ACTION, never on the
 * view: a customer who cannot get past it can still see what they were
 * quoted, ring the tradesperson, and talk about it.
 *
 * Everything here is pure so it can be tested without a database. Each
 * function decides whether a contract gets recorded.
 */

/** The words shown above the button. Stored verbatim on the record. */
export const affirmationFor = (businessName: string, total: string): string =>
  `I accept this quote from ${businessName} for ${total}.`

/**
 * Last four digits of a phone number, ignoring how it was written.
 *
 * Numbers reach us as "0412 345 678", "+61 412 345 678" and "(04) 1234-5678"
 * for the same phone, so compare digits only. The last four survive every one
 * of those forms, and crucially survive the country-code prefix, which the
 * leading digits do not.
 */
export const lastFour = (phone?: string): string | undefined => {
  const digits = String(phone ?? '').replace(/\D/g, '')
  return digits.length >= 4 ? digits.slice(-4) : undefined
}

/**
 * Names match on substance, not typing. A customer entering "marie o'brien"
 * for "Marie O'Brien" has identified themselves; refusing that is theatre that
 * costs a real acceptance.
 */
const normaliseName = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * Which check this quote can actually ask for.
 *
 * `phone4` degrades to `name` when there is no number on the quote, rather
 * than presenting a box nobody can satisfy. A configured check that locks the
 * customer out is worse than no check.
 */
export function effectiveCheck(configured: AcceptCheck, quote: Pick<QuoteRow, 'customerPhone'>): AcceptCheck {
  if (configured === 'phone4') return lastFour(quote.customerPhone) ? 'phone4' : 'name'
  return configured
}

export interface CheckFailure {
  error: string
  message: string
}

/**
 * Verify the customer's answer.
 *
 * Returns undefined when it passes. The messages are written for a homeowner
 * on a phone, and deliberately say what to do rather than what went wrong.
 */
export function verifyAccept(
  check: AcceptCheck,
  quote: Pick<QuoteRow, 'customerName' | 'customerPhone'>,
  answer: { name?: string; phone4?: string },
): CheckFailure | undefined {
  if (check === 'none') return undefined

  const typed = String(answer.name ?? '').trim()
  if (!typed) {
    return { error: 'name_required', message: 'Please type your name to accept.' }
  }
  // A name is a signature, and a single letter is not one.
  if (normaliseName(typed).replace(/ /g, '').length < 2) {
    return { error: 'name_too_short', message: 'Please type your full name.' }
  }
  /**
   * The name is NOT compared against the one on the quote.
   *
   * Deliberate. Quotes are addressed to "Marie" and accepted by her husband,
   * or made out to a company and accepted by whoever runs it. Rejecting those
   * blocks real, willing customers to prevent nothing - anyone holding the
   * link could read the name off the page and type it back. What the typed
   * name buys is a deliberate act attributable to a person, which is exactly
   * what a signature is, and it gets recorded either way.
   */

  if (check === 'phone4') {
    const want = lastFour(quote.customerPhone)
    // Should be unreachable via effectiveCheck, but a quote can lose its phone
    // between share and accept, and locking the customer out is the worse bug.
    if (!want) return undefined
    const got = String(answer.phone4 ?? '').replace(/\D/g, '')
    if (got !== want) {
      return {
        error: 'phone4_mismatch',
        message: 'That does not match. Enter the last 4 digits of the phone number this was sent to.',
      }
    }
  }
  return undefined
}

/**
 * The figures as displayed, frozen at acceptance.
 *
 * Without this the row stays mutable after the fact and nothing records what
 * the customer was actually looking at when they said yes.
 */
export const snapshotOf = (quote: QuoteRow): AcceptanceSnapshot => ({
  lines: quote.lines,
  subtotalCents: quote.subtotalCents,
  taxRate: quote.taxRate,
  taxCents: quote.taxCents,
  totalCents: quote.totalCents,
  currency: quote.currency,
  validUntil: quote.validUntil,
  ...(quote.notes ? { notes: quote.notes } : {}),
  ...(quote.terms ? { terms: quote.terms } : {}),
})

/**
 * A stable hash of the snapshot.
 *
 * Canonical on purpose: keys sorted, so the same figures always hash the same
 * regardless of the order JavaScript happened to serialise them in. A hash
 * that changes with key order proves nothing, because the party checking it
 * cannot reproduce it.
 */
export function documentHash(snapshot: AcceptanceSnapshot): string {
  return createHash('sha256').update(canonical(snapshot)).digest('hex')
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

/** The caller's address, for the acceptance record. */
export function callerIp(event: {
  requestContext?: { http?: { sourceIp?: string } }
}): string | undefined {
  // requestContext, never a header: X-Forwarded-For is client-settable, and an
  // IP an accepting party can choose is worth less than no IP at all.
  return event.requestContext?.http?.sourceIp || undefined
}
