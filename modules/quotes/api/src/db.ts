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

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired'

export interface QuoteRow {
  tenantId: string
  quoteId: string
  number: number
  contactId: string
  requestId?: string
  customerName?: string
  customerEmail?: string
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
  createdAt: string
  updatedAt: string
  sentAt?: string
  acceptedAt?: string
  declinedAt?: string
}

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
}

export const DEFAULT_QUOTES_CONFIG: Omit<QuotesConfigRow, 'tenantId'> = {
  taxRate: 0,
  taxLabel: 'GST',
  currency: 'AUD',
  terms: 'Valid for 30 days. Payment due on completion.',
  validDays: 30,
  notifyEmail: '',
  nextNumber: 1,
}

export async function getQuotesConfig(tenantId: string): Promise<QuotesConfigRow> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.config(), Key: { tenantId } }))
  return { tenantId, ...DEFAULT_QUOTES_CONFIG, ...(r.Item ?? {}) } as QuotesConfigRow
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
      UpdateExpression: 'SET nextNumber = if_not_exists(nextNumber, :one) + :one',
      ExpressionAttributeValues: { ':one': 1 },
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

/** A quote by its public token. Scoped to the tenant the link resolved to. */
export async function findByToken(tenantId: string, token: string): Promise<QuoteRow | undefined> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.quotes(),
      KeyConditionExpression: 'tenantId = :t',
      FilterExpression: 'publicToken = :tok',
      ExpressionAttributeValues: { ':t': tenantId, ':tok': token },
      Limit: 200,
    }),
  )
  return (r.Items ?? [])[0] as QuoteRow | undefined
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
