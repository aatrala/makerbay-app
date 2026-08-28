import { json } from '@makerbay/core'
import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { effectiveStatus, listQuotes, type QuoteRow } from './db'
import { listInvoices, type InvoiceRow } from './invoices'

/**
 * How the tradesperson's documents are actually doing (issue 119).
 *
 * The view counts that issues 118 and 119 started recording are only worth
 * collecting if somebody sees them, and they answer a question the existing
 * Usage page cannot: usage counts what the PLATFORM did, this counts what
 * CUSTOMERS did.
 *
 * The distinction the whole thing exists for: a quote nobody opened is a
 * DELIVERY problem - the link never arrived, or went to a dead number - and a
 * quote opened three times with no answer is a PRICE problem. Those need
 * opposite responses, and until now the dashboard showed the same "sent" chip
 * for both.
 *
 * Deliberately not a chart. A solo tradesperson between jobs wants three
 * numbers and a list of who to ring, not a dashboard to interpret.
 */

export interface DocFunnel {
  sent: number
  opened: number
  settled: number
  /** Money, so the numbers are in the units the owner thinks in. */
  sentCents: number
  settledCents: number
  currency: string
}

export interface NeedsChasing {
  id: string
  label: string
  who: string
  totalCents: number
  currency: string
  /** Days since it went out. */
  age: number
  /** Why it is on the list, in the owner's words. */
  reason: 'never opened' | 'opened, no answer' | 'overdue, never opened' | 'overdue'
}

const days = (from?: string): number =>
  from ? Math.floor((Date.now() - new Date(from).getTime()) / 86_400_000) : 0

/**
 * Quotes that are out and unanswered, and invoices that are out and unpaid.
 *
 * Sorted oldest first: the one that has been ignored longest is the one worth
 * a phone call, not the newest.
 */
function chase(quotes: QuoteRow[], invoices: InvoiceRow[]): NeedsChasing[] {
  const rows: NeedsChasing[] = []

  for (const q of quotes) {
    if (effectiveStatus(q) !== 'sent') continue
    rows.push({
      id: q.quoteId,
      label: `Quote ${q.number}`,
      who: q.customerName || q.customerEmail || q.customerPhone || 'someone',
      totalCents: q.totalCents,
      currency: q.currency,
      age: days(q.sentAt),
      reason: q.viewCount ? 'opened, no answer' : 'never opened',
    })
  }

  for (const i of invoices) {
    if (i.status !== 'sent') continue
    const overdue = new Date(i.dueAt).getTime() < Date.now()
    rows.push({
      id: i.invoiceId,
      label: `Invoice ${i.number}`,
      who: i.customerName || i.customerEmail || i.customerPhone || 'someone',
      totalCents: i.totalCents,
      currency: i.currency,
      age: days(i.sentAt),
      reason: overdue
        ? (i.viewCount ? 'overdue' : 'overdue, never opened')
        : (i.viewCount ? 'opened, no answer' : 'never opened'),
    })
  }

  return rows.sort((a, b) => b.age - a.age)
}

export async function documentInsights(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const [quotes, invoices] = await Promise.all([listQuotes(tenantId), listInvoices(tenantId)])

  // A quote counts as "sent" once it has left draft, whatever happened after -
  // otherwise accepting one would remove it from the denominator and the
  // open rate would climb every time somebody said yes.
  const out = quotes.filter((q) => q.status !== 'draft')
  const invOut = invoices.filter((i) => i.status !== 'draft' && i.status !== 'void')

  const quoteFunnel: DocFunnel = {
    sent: out.length,
    opened: out.filter((q) => (q.viewCount ?? 0) > 0).length,
    settled: out.filter((q) => q.status === 'accepted').length,
    sentCents: out.reduce((n, q) => n + q.totalCents, 0),
    settledCents: out.filter((q) => q.status === 'accepted').reduce((n, q) => n + q.totalCents, 0),
    currency: out[0]?.currency ?? 'AUD',
  }
  const invoiceFunnel: DocFunnel = {
    sent: invOut.length,
    opened: invOut.filter((i) => (i.viewCount ?? 0) > 0).length,
    settled: invOut.filter((i) => i.status === 'paid').length,
    sentCents: invOut.reduce((n, i) => n + i.totalCents, 0),
    settledCents: invOut.filter((i) => i.status === 'paid').reduce((n, i) => n + i.totalCents, 0),
    currency: invOut[0]?.currency ?? 'AUD',
  }

  return json(200, {
    quotes: quoteFunnel,
    invoices: invoiceFunnel,
    // Capped: this is a call list, and a list nobody can finish is one nobody
    // starts. The counts above still reflect everything.
    chase: chase(quotes, invoices).slice(0, 12),
    /**
     * Whether view counting was running when these documents went out.
     *
     * Anything sent before issues 118/119 has no view data, so its "never
     * opened" is an absence of evidence rather than evidence of absence. The
     * screen says so instead of quietly reporting zeros as fact.
     */
    viewTrackingSince: '2026-08-28',
  })
}
