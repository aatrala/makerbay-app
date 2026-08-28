import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, lineTotalCents } from '@makerbay/core'

const Tables = {
  items: () => process.env.TABLE_PRICEITEMS!,
  quotes: () => process.env.TABLE_QUOTES!,
  config: () => process.env.TABLE_QUOTESCONFIG!,
}

export interface PriceItemRow {
  tenantId: string
  itemId: string
  description: string
  unit: string
  unitCents: number
  active: boolean
  createdAt: string
}

export interface QuoteLine {
  description: string
  unit: string
  quantity: number
  unitCents: number
  /** Stored, not derived on read, so a sent quote can never re-price itself. */
  totalCents: number
}

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'superseded'

export interface QuoteRow {
  tenantId: string
  quoteId: string
  number: number
  contactId: string
  requestId?: string
  customerName?: string
  customerEmail?: string
  /**
   * The number the link was sent to. Optional, and the only identifier a
   * tradesperson reliably has when there is no email (issue 118). Also what
   * the last-four accept check compares against.
   */
  customerPhone?: string
  lines: QuoteLine[]
  subtotalCents: number
  taxRate: number
  taxCents: number
  totalCents: number
  currency: string
  notes?: string
  terms?: string
  status: QuoteStatus
  publicToken: string
  validUntil: string
  notifyError?: string
  /** Set when an invoice is created from this quote - one invoice per quote. */
  invoiceId?: string
  invoicedAt?: string
  createdAt: string
  updatedAt: string
  sentAt?: string
  acceptedAt?: string
  declinedAt?: string
  /**
   * The replacement's public token, so the customer holding an old link can be
   * pointed at the current version. Written by revise.
   *
   * Was previously written and read through three separate inline casts, which
   * is how the type stayed silent while the field was load-bearing.
   */
  supersededByToken?: string
  /** The quote this one replaces. Written by revise. */
  revisionOf?: string
  /**
   * What was agreed, by whom, to what wording (issue 118).
   *
   * Before this, accepting wrote `acceptedAt` and nothing else. In a dispute
   * over a four-figure job that proves something happened, not that this
   * customer agreed to these figures. Written once, never updated.
   */
  acceptance?: AcceptanceRecord
  /** Set when the owner kills a shared link. The old token stops resolving. */
  tokenRotatedAt?: string
  /** Honest delivery signal when there is no email to track (issue 118). */
  firstViewedAt?: string
  lastViewedAt?: string
  viewCount?: number
  /** How the link reached the customer, so "sent" is a fact and not a claim. */
  sharedVia?: 'email' | 'link'
}

/**
 * The evidence behind an acceptance.
 *
 * Deliberately facts about the transaction, not observation of the person:
 * no geolocation, no fingerprinting, no behavioural trail. Each field earns
 * its place by answering a question a dispute would actually ask.
 */
export interface AcceptanceRecord {
  at: string
  /**
   * The customer's typed name. This is the signature - a bare button click is
   * anonymous, and under the AU ETA / UK ECA / US ESIGN regimes it is the
   * deliberate act of typing a name that carries weight.
   */
  name: string
  /**
   * Full, not truncated. The whole evidential point is telling the customer's
   * own connection from somebody else's, and a masked IP proves neither.
   * Lawful basis is performance of a contract; it lives and dies with the quote.
   */
  ip?: string
  userAgent?: string
  /** The exact words shown above the button, so what was agreed to is provable. */
  affirmation: string
  /** Which extra check was satisfied, if any. */
  check: AcceptCheck
  /**
   * SHA-256 over a canonical form of the figures displayed. One short string
   * an adjudicator can compare, and it makes later tampering detectable
   * rather than merely discouraged.
   */
  documentHash: string
  /** The figures themselves, frozen. The hash is only useful with these. */
  snapshot: AcceptanceSnapshot
}

export interface AcceptanceSnapshot {
  lines: QuoteLine[]
  subtotalCents: number
  taxRate: number
  taxCents: number
  totalCents: number
  currency: string
  validUntil: string
  notes?: string
  terms?: string
}

/**
 * What a customer must do to accept, beyond tapping.
 *
 * `name` is the default and the floor: it is the signature, so it is never
 * skipped for the sake of one fewer field. `phone4` adds the last four digits
 * of the number the link went to - the customer cannot forget it, it needs no
 * separate message, and it is checkable. `none` exists for a business that
 * wants a bare tap and accepts what that costs them in a dispute.
 */
export type AcceptCheck = 'none' | 'name' | 'phone4'

export interface QuotesConfigRow {
  tenantId: string
  /** Single workspace-level rate in v1. Per-line tax is a deliberate change. */
  taxRate: number
  taxLabel: string
  currency: string
  terms: string
  validDays: number
  notifyEmail: string
  /** Monotonic per tenant, so quote numbers read like a real business. */
  nextNumber: number
  /** Optional tag in front of every document number: SP → SP-Q-001. */
  docPrefix?: string
  /** Identity line under every document: ABN, licence number, whatever compliance asks for. */
  docFooter?: string
  /** Business photo as the document logo (defaults on when a photo exists). */
  showLogoOnDocs?: boolean
  /**
   * What a customer must do to accept (issue 118). Defaults to `name`: with no
   * email in the loop the link is the whole delivery mechanism, and a typed
   * name is both the gate and the signature.
   */
  acceptCheck?: AcceptCheck
}

/**
 * The tax a customer expects to see named on an invoice. Getting this wrong is
 * not cosmetic: a UK invoice that says "GST" instead of "VAT" looks like it
 * came from someone who does not know the rules (issue 114).
 */
const TAX_LABEL: Record<string, string> = {
  GBP: 'VAT', EUR: 'VAT',
  USD: 'Sales tax', CAD: 'Sales tax',
  AUD: 'GST', NZD: 'GST', SGD: 'GST', INR: 'GST',
  ZAR: 'VAT', AED: 'VAT',
}

export const DEFAULT_QUOTES_CONFIG: Omit<QuotesConfigRow, 'tenantId'> = {
  acceptCheck: 'name',
  taxRate: 0,
  taxLabel: 'GST',
  currency: 'AUD',
  terms: 'Valid for 30 days. Payment due on completion.',
  validDays: 30,
  notifyEmail: '',
  nextNumber: 1,
  docPrefix: '',
}

export async function getQuotesConfig(tenantId: string): Promise<QuotesConfigRow> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.config(), Key: { tenantId } }))
  // A workspace that has never opened the quotes settings inherits the
  // currency detected at signup, rather than being handed Australia's. Only
  // when the row itself is silent - once the owner saves, their choice wins
  // even if it happens to match the default.
  const stored = (r.Item ?? {}) as Partial<QuotesConfigRow>
  const fallback = { ...DEFAULT_QUOTES_CONFIG }
  if (stored.currency === undefined) {
    const { getTenant } = await import('@makerbay/core')
    const currency = (await getTenant(tenantId))?.currency
    if (currency) {
      fallback.currency = currency
      fallback.taxLabel = TAX_LABEL[currency] ?? fallback.taxLabel
    }
  }
  return { tenantId, ...fallback, ...stored } as QuotesConfigRow
}

export async function putQuotesConfig(row: QuotesConfigRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.config(), Item: row }))
}

/**
 * Reserve the next quote number atomically. Two quotes created at the same
 * moment must never share a number - the customer sees it, and so does their
 * accountant.
 */
export async function nextQuoteNumber(tenantId: string): Promise<number> {
  const r = await ddb.send(
    new UpdateCommand({
      TableName: Tables.config(),
      Key: { tenantId },
      // if_not_exists must seed ZERO: seeding with :one made the first
      // document number 2, which customers noticed.
      UpdateExpression: 'SET nextNumber = if_not_exists(nextNumber, :zero) + :one',
      ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  )
  return Number(r.Attributes?.nextNumber ?? 1)
}

export async function listPriceItems(tenantId: string): Promise<PriceItemRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.items(),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
    }),
  )
  return ((r.Items ?? []) as PriceItemRow[]).sort((a, b) => a.description.localeCompare(b.description))
}

export async function putPriceItem(row: PriceItemRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.items(), Item: row }))
}

export async function getPriceItem(tenantId: string, itemId: string): Promise<PriceItemRow | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.items(), Key: { tenantId, itemId } }))
  return r.Item as PriceItemRow | undefined
}

export async function deletePriceItem(tenantId: string, itemId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: Tables.items(), Key: { tenantId, itemId } }))
}

export async function putQuote(row: QuoteRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.quotes(), Item: row }))
}

/**
 * Count a view without touching anything else on the row.
 *
 * The first version of this read the whole quote, incremented a counter and
 * wrote the whole row back. Two requests reading before either wrote meant the
 * second Put restored every field the first had changed - so a view landing
 * just after an acceptance reverted `status` to `sent` and ERASED the signed
 * acceptance record. A counter is never worth a read-modify-write of a row
 * that carries a contract.
 *
 * ADD is atomic and touches only the three attributes named here.
 * `if_not_exists` keeps the first view's timestamp as the first, whichever
 * request happens to arrive first.
 */
export async function countQuoteView(tenantId: string, quoteId: string, at: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: Tables.quotes(),
    Key: { tenantId, quoteId },
    UpdateExpression:
      'ADD viewCount :one SET lastViewedAt = :at, firstViewedAt = if_not_exists(firstViewedAt, :at)',
    // Never resurrect a deleted quote as a stub containing only view counts.
    ConditionExpression: 'attribute_exists(quoteId)',
    ExpressionAttributeValues: { ':one': 1, ':at': at },
  }))
}

export async function getQuote(tenantId: string, quoteId: string): Promise<QuoteRow | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.quotes(), Key: { tenantId, quoteId } }))
  return r.Item as QuoteRow | undefined
}

export async function listQuotes(tenantId: string, status?: QuoteStatus): Promise<QuoteRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.quotes(),
      KeyConditionExpression: 'tenantId = :t',
      ...(status
        ? { FilterExpression: '#st = :st', ExpressionAttributeNames: { '#st': 'status' } }
        : {}),
      ExpressionAttributeValues: status ? { ':t': tenantId, ':st': status } : { ':t': tenantId },
      ScanIndexForward: false,
      Limit: 200,
    }),
  )
  return (r.Items ?? []) as QuoteRow[]
}

/**
 * A quote by its public token. Scoped to the tenant the link resolved to.
 *
 * Queries the byPublicToken index rather than scanning the tenant's quotes.
 * The old version used a FilterExpression with `Limit: 200`, and DynamoDB
 * applies Limit BEFORE the filter - so it read the first 200 quotes by id and
 * searched only inside those. Past 200 quotes, newly issued links 404 for a
 * customer holding a link that was sent to them.
 *
 * The tenant check stays, and moves from the query to the row: the token is
 * globally unique, so the index finds it without a tenant, but a token must
 * never resolve under a DIFFERENT tenant's slug.
 */
export async function findByToken(tenantId: string, token: string): Promise<QuoteRow | undefined> {
  if (!token) return undefined
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.quotes(),
      IndexName: 'byPublicToken',
      KeyConditionExpression: 'publicToken = :tok',
      ExpressionAttributeValues: { ':tok': token },
      Limit: 1,
    }),
  )
  const quote = (r.Items ?? [])[0] as QuoteRow | undefined
  return quote?.tenantId === tenantId ? quote : undefined
}

// ── Money ────────────────────────────────────────────────────────────────

export interface TotalsInput {
  lines: Array<{ quantity: number; unitCents: number }>
  taxRate: number
}

/**
 * Totals from lines. Each line is rounded once and the subtotal is the sum of
 * those rounded values, so what a customer adds up by hand matches what we
 * charge them. Rounding the whole thing at the end does not.
 */
export function computeTotals(input: TotalsInput): {
  lineTotals: number[]
  subtotalCents: number
  taxCents: number
  totalCents: number
} {
  const lineTotals = input.lines.map((l) => lineTotalCents(l.quantity, l.unitCents))
  const subtotalCents = lineTotals.reduce((a, b) => a + b, 0)
  const taxCents = Math.round(subtotalCents * Math.max(0, input.taxRate))
  return { lineTotals, subtotalCents, taxCents, totalCents: subtotalCents + taxCents }
}

/** A quote past its date is not a price. Evaluated lazily on read. */
export const isExpired = (quote: QuoteRow, now = new Date()): boolean =>
  quote.status === 'sent' && new Date(quote.validUntil).getTime() < now.getTime()

export const effectiveStatus = (quote: QuoteRow, now = new Date()): QuoteStatus =>
  isExpired(quote, now) ? 'expired' : quote.status
