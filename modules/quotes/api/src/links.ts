/**
 * The customer-facing address of a quote or an invoice (issue 118 phase 2).
 *
 * One definition, and this time enforced: `quoteUrl` already carried the
 * comment "one definition, so it cannot drift" while `detail()` and
 * `invoiceDetail()` rebuilt the same URL inline, without encoding. Four sites,
 * two shapes. Everything now routes through here.
 *
 * The shape is readable on purpose, because it is read by a homeowner in a
 * WhatsApp message from a number they may not recognise:
 *
 *   https://quote.makerbay.app/dunn-plumbing/Q-014/IdC_9xKq2mVvA1sPzR7bWnLe
 *
 * What it deliberately does NOT contain:
 * - A timestamp. It authenticates nothing (unverifiable without reading the
 *   row, and `validUntil` is on the row anyway), cannot expire anything at the
 *   edge because it is attacker-controlled, and leaks when the quote was
 *   raised.
 * - A query string. `?` and `&` are what make SMS and older mail clients
 *   truncate and mangle a URL.
 *
 * The token is last, and it is the entire authorisation for the document: 24
 * random bytes. It is never shortened to prettify the URL.
 */

/** Which document, which host. The kind is in the host so it reads first. */
export type DocKind = 'quote' | 'invoice'

const HOST: Record<DocKind, string> = {
  quote: 'https://quote.makerbay.app',
  invoice: 'https://invoice.makerbay.app',
}

/**
 * The old address, still built for anything that needs to keep working.
 * Links already in customers' hands point here, and an invoice link is a
 * payment instrument that people dig out months later, so this host is not
 * going away on a deprecation timer.
 */
export const LEGACY_HOST = 'https://chat.makerbay.app'

/**
 * Path segments are encoded even though slugs and document labels are
 * validated: encoding at the boundary is what stops the next field that
 * reaches this function from being the one that breaks it.
 */
export function docUrl(kind: DocKind, slug: string, label: string, token: string): string {
  const parts = [slug, label, token].map((p) => encodeURIComponent(String(p ?? '').trim()))
  return `${HOST[kind]}/${parts.join('/')}`
}

/**
 * Read a document address back.
 *
 * Accepts both shapes, because the page has to serve links that were sent
 * before this existed:
 *   /dunn-plumbing/Q-014/TOKEN   (current)
 *   /quote?slug=…&token=…        (legacy, handled by the caller's query parse)
 *
 * Returns undefined rather than guessing when the path is not a document.
 */
export function parseDocPath(path: string): { slug: string; label: string; token: string } | undefined {
  const parts = String(path ?? '').split('/').filter(Boolean).map(decodeURIComponent)
  if (parts.length < 3) return undefined
  // Last segment is the token; the two before it are the business and the
  // document label. Anything deeper is not a shape we issue.
  const [slug, label, token] = parts
  if (!slug || !token) return undefined
  return { slug, label, token }
}
