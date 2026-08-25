import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { appendContactEvent, ddb, emitUsage, getTenant, linkToken, money, sendEmail, ulid } from '@makerbay/core'
import { getQuotesConfig, type QuoteLine, type QuoteRow } from './db'

/**
 * Simple invoices, deliberately bounded. An invoice here is a document a
 * customer can open, read and pay against - usually born from an accepted
 * quote. What it is NOT: bookkeeping. No tax accounting beyond the single
 * workspace rate, no reconciliation, no ledgers - that is Xero and MYOB
 * territory, and the public roadmap says so.
 */

const Tables = {
  invoices: () => process.env.TABLE_INVOICES!,
  config: () => process.env.TABLE_QUOTESCONFIG!,
}
const CHAT = 'https://chat.makerbay.app'

export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'void'
export const INVOICE_THEMES = ['classic', 'compact', 'bold'] as const
export type InvoiceTheme = (typeof INVOICE_THEMES)[number]

export interface InvoiceRow {
  tenantId: string
  invoiceId: string
  number: number
  quoteId?: string
  contactId?: string
  customerName?: string
  customerEmail?: string
  lines: QuoteLine[]
  subtotalCents: number
  taxRate: number
  taxCents: number
  totalCents: number
  currency: string
  notes?: string
  /** Bank details, PayID, UPI - however this business actually gets paid. */
  paymentInstructions?: string
  status: InvoiceStatus
  publicToken: string
  dueAt: string
  createdAt: string
  updatedAt: string
  sentAt?: string
  paidAt?: string
  notifyError?: string
}

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** Invoice numbers are their own atomic series - INV-7 must never repeat. */
async function nextInvoiceNumber(tenantId: string): Promise<number> {
  const r = await ddb.send(
    new UpdateCommand({
      TableName: Tables.config(),
      Key: { tenantId },
      // Seed ZERO, not one - the first invoice must be 001, not 002.
      UpdateExpression: 'SET nextInvoiceNumber = if_not_exists(nextInvoiceNumber, :zero) + :one',
      ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  )
  return Number(r.Attributes?.nextInvoiceNumber ?? 1)
}

export async function getInvoice(tenantId: string, invoiceId: string): Promise<InvoiceRow | undefined> {
  const r = await ddb.send(
    new GetCommand({ TableName: Tables.invoices(), Key: { tenantId, invoiceId } }),
  )
  return r.Item as InvoiceRow | undefined
}

export async function listInvoices(tenantId: string): Promise<InvoiceRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.invoices(),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
      ScanIndexForward: false,
      Limit: 200,
    }),
  )
  return (r.Items ?? []) as InvoiceRow[]
}

export async function findInvoiceByToken(tenantId: string, token: string): Promise<InvoiceRow | undefined> {
  return (await listInvoices(tenantId)).find((i) => i.publicToken === token)
}

/**
 * An invoice from an accepted quote: the lines and totals are copied, never
 * recomputed, because the customer already agreed to those exact figures.
 */
export async function invoiceFromQuote(tenantId: string, quote: QuoteRow): Promise<InvoiceRow> {
  if (quote.status !== 'accepted') {
    throw Object.assign(new Error('quote_not_accepted'), { code: 'quote_not_accepted' })
  }
  const config = await getQuotesConfig(tenantId)
  const now = new Date().toISOString()
  const invoice: InvoiceRow = {
    tenantId,
    invoiceId: ulid(),
    number: await nextInvoiceNumber(tenantId),
    quoteId: quote.quoteId,
    contactId: quote.contactId,
    customerName: quote.customerName,
    customerEmail: quote.customerEmail,
    lines: quote.lines,
    subtotalCents: quote.subtotalCents,
    taxRate: quote.taxRate,
    taxCents: quote.taxCents,
    totalCents: quote.totalCents,
    currency: quote.currency,
    notes: quote.notes,
    paymentInstructions: (config as { paymentInstructions?: string }).paymentInstructions,
    status: 'draft',
    publicToken: linkToken(),
    dueAt: new Date(Date.now() + ((config as { dueDays?: number }).dueDays ?? 14) * 86_400_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  }
  await ddb.send(new PutCommand({ TableName: Tables.invoices(), Item: invoice }))
  return invoice
}

export async function sendInvoice(tenantId: string, invoiceId: string): Promise<APIGatewayProxyResultV2> {
  const invoice = await getInvoice(tenantId, invoiceId)
  if (!invoice) return json(404, { error: 'not_found' })
  if (invoice.status === 'void') return json(409, { error: 'invoice_void' })
  if (!invoice.customerEmail) {
    return json(400, { error: 'no_customer_email', message: 'This customer has no email address.' })
  }

  const tenant = await getTenant(tenantId)
  const config = await getQuotesConfig(tenantId)
  const label = invoiceLabel(invoice, config.docPrefix)
  const url = `${CHAT}/invoice?slug=${tenant?.slug ?? ''}&token=${invoice.publicToken}`
  const due = new Date(invoice.dueAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  const notice = await sendEmail({
    to: invoice.customerEmail,
    subject: `Invoice ${label} from ${tenant?.name ?? 'us'} - ${money(invoice.totalCents, invoice.currency)}`,
    text: [
      `${invoice.customerName ?? 'Hello'},`,
      '',
      `Invoice ${label} for ${money(invoice.totalCents, invoice.currency)}, due ${due}.`,
      '',
      `View it here: ${url}`,
      invoice.paymentInstructions ? `\nHow to pay:\n${invoice.paymentInstructions}` : '',
      '',
      tenant?.name ?? '',
    ].join('\n'),
  })

  const now = new Date().toISOString()
  const updated: InvoiceRow = {
    ...invoice,
    status: invoice.status === 'draft' ? 'sent' : invoice.status,
    sentAt: invoice.sentAt ?? now,
    updatedAt: now,
    notifyError: notice.sent ? undefined : notice.error,
  }
  await ddb.send(new PutCommand({ TableName: Tables.invoices(), Item: updated }))
  if (invoice.contactId) {
    await appendContactEvent(tenantId, invoice.contactId, {
      moduleId: 'quotes',
      title: `Sent invoice ${label} for ${money(invoice.totalCents, invoice.currency)}`,
    })
  }
  await emitUsage({ tenantId, moduleId: 'quotes', metric: 'invoice.sent', quantity: 1 })
  return json(200, { invoice: updated, publicUrl: url, emailed: notice.sent, emailError: notice.error })
}

export async function patchInvoice(
  tenantId: string,
  invoiceId: string,
  b: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const invoice = await getInvoice(tenantId, invoiceId)
  if (!invoice) return json(404, { error: 'not_found' })
  // A paid invoice is a record of money received; it does not change.
  if (invoice.status === 'paid' && b.status !== 'void') {
    return json(409, { error: 'invoice_paid', message: 'This invoice is already marked paid.' })
  }

  const status = ['paid', 'void', 'sent'].includes(String(b.status)) ? (b.status as InvoiceStatus) : undefined
  const now = new Date().toISOString()
  const updated: InvoiceRow = {
    ...invoice,
    ...(status ? { status } : {}),
    ...(status === 'paid' ? { paidAt: now } : {}),
    ...(b.paymentInstructions !== undefined
      ? { paymentInstructions: String(b.paymentInstructions).slice(0, 1000) }
      : {}),
    ...(b.notes !== undefined ? { notes: String(b.notes).slice(0, 2000) } : {}),
    updatedAt: now,
  }
  await ddb.send(new PutCommand({ TableName: Tables.invoices(), Item: updated }))
  if (status === 'paid' && invoice.contactId) {
    const cfg = await getQuotesConfig(tenantId)
    await appendContactEvent(tenantId, invoice.contactId, {
      moduleId: 'quotes',
      title: `Invoice ${invoiceLabel(invoice, cfg.docPrefix)} paid - ${money(invoice.totalCents, invoice.currency)}`,
    })
    await emitUsage({ tenantId, moduleId: 'quotes', metric: 'invoice.paid', quantity: 1 })
  }
  return json(200, { invoice: updated })
}

/** The business photo from Your page, worn as the document logo. */
export async function documentLogo(
  tenantId: string,
  config: { showLogoOnDocs?: boolean },
): Promise<string | undefined> {
  if (config.showLogoOnDocs === false) return undefined
  try {
    const r = await ddb.send(new GetCommand({
      TableName: process.env.TABLE_PRESENCECONFIG!,
      Key: { tenantId },
    }))
    const key = r.Item?.photoKey
    return key ? `https://chat.makerbay.app/${String(key)}` : undefined
  } catch {
    return undefined
  }
}

/**
 * Document labels: an optional per-tenant tag, the document kind, and a
 * number padded to three digits - SP-INV-001 reads like a real business,
 * INV-0007 reads like software.
 */
export const docLabel = (kind: 'Q' | 'INV', number: number, prefix = ''): string =>
  `${prefix ? `${prefix}-` : ''}${kind}-${String(number).padStart(3, '0')}`

export const invoiceLabel = (i: Pick<InvoiceRow, 'number'>, prefix = ''): string =>
  docLabel('INV', i.number, prefix)

export const quoteLabel = (number: number, prefix = ''): string => docLabel('Q', number, prefix)

/** The public JSON the themed page renders from. Theme comes from config. */
export async function publicInvoiceView(
  tenantId: string,
  businessName: string,
  token: string,
  payoutsEnabled = false,
): Promise<APIGatewayProxyResultV2> {
  const invoice = await findInvoiceByToken(tenantId, token)
  if (!invoice || invoice.status === 'draft') return json(404, { error: 'not_found' })
  const config = await getQuotesConfig(tenantId)
  const logoUrl = await documentLogo(tenantId, config)
  return json(200, {
    business: businessName,
    footer: config.docFooter || undefined,
    logoUrl,
    theme: (config as { invoiceTheme?: string }).invoiceTheme ?? 'classic',
    // A pay button appears only when it would actually work.
    payable: payoutsEnabled && invoice.status === 'sent',
    invoice: {
      label: invoiceLabel(invoice, (config as { docPrefix?: string }).docPrefix ?? ''),
      status: invoice.status,
      lines: invoice.lines,
      subtotalCents: invoice.subtotalCents,
      taxCents: invoice.taxCents,
      taxLabel: config.taxLabel,
      totalCents: invoice.totalCents,
      currency: invoice.currency,
      notes: invoice.notes,
      paymentInstructions: invoice.paymentInstructions,
      customerName: invoice.customerName,
      issuedAt: invoice.sentAt ?? invoice.createdAt,
      dueAt: invoice.dueAt,
      paidAt: invoice.paidAt,
    },
  })
}
