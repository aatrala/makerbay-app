import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import {
  appendContactEvent, ddb, emitUsage, getTenant, getTenantBrand, json, linkToken, money, sendEmail, ulid,
  type TenantBrand,
} from '@makerbay/core'
import { getQuotesConfig, type QuoteLine, type QuoteRow } from './db'
import { docUrl } from './links'
import { invoiceSent } from '@makerbay/email'
import { docQr } from './qr'

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
  /**
   * Whether the customer has opened it (issue 119 review).
   *
   * Quotes have counted views since issue 118; invoices counted nothing at
   * all - so unauthorised access to the page carrying the customer's name and
   * the tradesperson's bank details left no trace whatsoever, and the owner
   * could not tell an unpaid invoice that was never opened from one that was
   * read and ignored. Those need opposite responses.
   */
  firstViewedAt?: string
  lastViewedAt?: string
  viewCount?: number
  /** Set when the owner kills a shared link. The old token stops resolving. */
  tokenRotatedAt?: string
  /** The number the link went to, when there is no email (issue 118). */
  customerPhone?: string
}

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

/**
 * An invoice by its public token.
 *
 * Was `listInvoices(tenantId).find(...)`, which reads at most 200 rows with
 * `ScanIndexForward: false` - so once a tenant passed 200 invoices, it was the
 * OLDER ones whose links silently stopped resolving. Now an exact lookup on
 * the byPublicToken index, with the tenant checked on the row so a token
 * cannot be replayed under another tenant's slug.
 */
export async function findInvoiceByToken(tenantId: string, token: string): Promise<InvoiceRow | undefined> {
  if (!token) return undefined
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.invoices(),
      IndexName: 'byPublicToken',
      KeyConditionExpression: 'publicToken = :tok',
      ExpressionAttributeValues: { ':tok': token },
      Limit: 1,
    }),
  )
  const invoice = (r.Items ?? [])[0] as InvoiceRow | undefined
  return invoice?.tenantId === tenantId ? invoice : undefined
}

/**
 * Note that the customer opened an invoice.
 *
 * Atomic, for the same reason as the quote counter: a read-modify-write of the
 * whole row would let a view landing after a payment revert `status` and erase
 * `paidAt`. A counter is never worth rewriting a row that records money.
 */
export async function countInvoiceView(tenantId: string, invoiceId: string, at: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: Tables.invoices(),
    Key: { tenantId, invoiceId },
    UpdateExpression:
      'ADD viewCount :one SET lastViewedAt = :at, firstViewedAt = if_not_exists(firstViewedAt, :at)',
    ConditionExpression: 'attribute_exists(invoiceId)',
    ExpressionAttributeValues: { ':one': 1, ':at': at },
  }))
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
    customerPhone: quote.customerPhone,
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

/** The customer's link for an invoice. Built in exactly one place (./links). */
export const invoiceUrl = (slug: string, label: string, token: string): string =>
  docUrl('invoice', slug, label, token)

/**
 * Hand back the customer link without sending anything (issue 118).
 *
 * The invoice screen already showed a link unconditionally, but the public
 * view 404s on a draft - so a tradesperson could copy a link that told their
 * customer "this invoice could not be found". Sharing marks it sent, which
 * makes the link the copy button hands over actually work.
 */
export async function shareInvoice(tenantId: string, invoiceId: string): Promise<APIGatewayProxyResultV2> {
  const invoice = await getInvoice(tenantId, invoiceId)
  if (!invoice) return json(404, { error: 'not_found' })
  if (invoice.status === 'void') return json(409, { error: 'invoice_void' })

  const [tenant, config] = await Promise.all([getTenant(tenantId), getQuotesConfig(tenantId)])
  const label = invoiceLabel(invoice, config.docPrefix)
  const now = new Date().toISOString()
  const updated: InvoiceRow = {
    ...invoice,
    status: invoice.status === 'draft' ? 'sent' : invoice.status,
    sentAt: invoice.sentAt ?? now,
    updatedAt: now,
  }
  await ddb.send(new PutCommand({ TableName: Tables.invoices(), Item: updated }))
  if (invoice.contactId) {
    await appendContactEvent(tenantId, invoice.contactId, {
      moduleId: 'quotes',
      title: `Shared a link to invoice ${label} for ${money(invoice.totalCents, invoice.currency)}`,
    })
  }
  await emitUsage({ tenantId, moduleId: 'quotes', metric: 'invoice.sent', quantity: 1 })
  return json(200, {
    invoice: updated,
    publicUrl: invoiceUrl(tenant?.slug ?? '', label, invoice.publicToken),
    label,
    emailed: false,
  })
}

/** Kill a shared invoice link and mint a new one. */
export async function revokeInvoiceLink(tenantId: string, invoiceId: string): Promise<APIGatewayProxyResultV2> {
  const invoice = await getInvoice(tenantId, invoiceId)
  if (!invoice) return json(404, { error: 'not_found' })
  // A paid invoice is the customer's receipt. Rotating its link would strand
  // them, and there is nothing left to protect.
  if (invoice.status === 'paid') {
    return json(409, {
      error: 'invoice_paid',
      message: 'This invoice is paid, so its link cannot be changed. The customer needs it as their receipt.',
    })
  }

  const [tenant, config] = await Promise.all([getTenant(tenantId), getQuotesConfig(tenantId)])
  const now = new Date().toISOString()
  const updated: InvoiceRow = {
    ...invoice,
    publicToken: linkToken(),
    tokenRotatedAt: now,
    updatedAt: now,
  }
  await ddb.send(new PutCommand({ TableName: Tables.invoices(), Item: updated }))
  const label = invoiceLabel(invoice, config.docPrefix)
  if (invoice.contactId) {
    await appendContactEvent(tenantId, invoice.contactId, {
      moduleId: 'quotes',
      title: `Stopped the old link to invoice ${label} working`,
    })
  }
  return json(200, {
    invoice: updated,
    publicUrl: invoiceUrl(tenant?.slug ?? '', label, updated.publicToken),
    label,
  })
}

export async function sendInvoice(
  tenantId: string,
  invoiceId: string,
): Promise<APIGatewayProxyResultV2> {
  const invoice = await getInvoice(tenantId, invoiceId)
  if (!invoice) return json(404, { error: 'not_found' })
  if (invoice.status === 'void') return json(409, { error: 'invoice_void' })
  if (!invoice.customerEmail) {
    return json(400, {
      error: 'no_customer_email',
      message: 'This customer has no email address. Share the link instead and send it however you like.',
    })
  }

  const tenant = await getTenant(tenantId)
  const config = await getQuotesConfig(tenantId)
  const label = invoiceLabel(invoice, config.docPrefix)
  const url = invoiceUrl(tenant?.slug ?? '', label, invoice.publicToken)
  const due = new Date(invoice.dueAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  })
  const brand = await getTenantBrand(tenantId)
  const mail = invoiceSent({
    brand,
    contact: { email: config.notifyEmail || undefined },
    customerName: invoice.customerName,
    label,
    total: money(invoice.totalCents, invoice.currency),
    due,
    url,
    // A pay button only when it would actually work; otherwise the bank
    // details, which is how most of these get paid today. Read off the tenant
    // row fetched above - an earlier version took this as a parameter that
    // the only call site never passed, so the button was unreachable.
    payable: tenant?.payoutsEnabled === true && invoice.status !== 'paid',
    howToPay: invoice.paymentInstructions,
  })
  const notice = await sendEmail({
    to: invoice.customerEmail,
    ref: { tenantId, moduleId: 'quotes', refType: 'invoice', refId: invoice.invoiceId },
    audience: 'customer' as const,
    fromName: brand.name,
    replyTo: config.notifyEmail ?? '',
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
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

/**
 * The business photo from Your page, worn as the document logo.
 *
 * Pure: the photo and the phone both ride on TenantBrand now, which is the
 * core seam over the presence table - this module no longer reads that table
 * itself (CLAUDE.md: data access goes through packages/core).
 */
export const documentLogo = (
  config: { showLogoOnDocs?: boolean },
  brand: Pick<TenantBrand, 'photoUrl'>,
): string | undefined =>
  config.showLogoOnDocs === false ? undefined : brand.photoUrl


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
  slug = '',
): Promise<APIGatewayProxyResultV2> {
  const invoice = await findInvoiceByToken(tenantId, token)
  if (!invoice || invoice.status === 'draft') return json(404, { error: 'not_found' })
  const [config, brand] = await Promise.all([
    getQuotesConfig(tenantId),
    getTenantBrand(tenantId),
  ])
  const logoUrl = documentLogo(config, brand)
  // On paper there is no reply button; the number is how a printed invoice
  // gets queried rather than filed and forgotten.
  const phone = brand.phone
  const label = invoiceLabel(invoice, (config as { docPrefix?: string }).docPrefix ?? '')
  /**
   * A void invoice has nothing to open. A PAID one keeps its square, because
   * paper is exactly where it earns its place: the printed sheet is the
   * customer's receipt, and scanning it is how they get back to the record
   * months later at tax time.
   */
  const qr = invoice.status !== 'void'
    ? await docQr(invoiceUrl(slug, label, invoice.publicToken))
    : undefined
  // Counted here, in the API the page's own JavaScript calls - never at the
  // CDN, where a link-preview bot would fire it the instant the message is
  // sent and the owner would be told "opened" before anyone had looked.
  try {
    await countInvoiceView(tenantId, invoice.invoiceId, new Date().toISOString())
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
      console.warn('invoice view count failed', { tenantId, err: String(err) })
    }
  }
  return json(200, {
    business: businessName,
    footer: config.docFooter || undefined,
    logoUrl,
    ...(phone ? { phone } : {}),
    ...(qr ? { qr } : {}),
    theme: (config as { invoiceTheme?: string }).invoiceTheme ?? 'classic',
    // A pay button appears only when it would actually work.
    payable: payoutsEnabled && invoice.status === 'sent',
    invoice: {
      label,
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
