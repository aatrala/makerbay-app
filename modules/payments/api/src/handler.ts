import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import {
  appendContactEvent,
  ddb,
  emitEvent,
  emitUsage,
  getTenant,
  getTenantBySlug,
  getTenantByStripeAccount,
  getUser,
  setTenantConnect,
  ulid,
  type CallerContext,
} from '@makerbay/core'
import { stripe } from './stripe'

/**
 * Stripe Connect payments: money from a customer to a tradie, never through
 * our hands. Express accounts (Stripe owns onboarding and KYC), destination
 * charges (funds route straight to the connected account), Checkout Sessions
 * (card data never touches us).
 *
 * The webhook is the only thing that marks money received. A success redirect
 * proves nothing - the customer's browser is not a source of truth.
 */

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

interface StripeForwardedEvent {
  'detail-type': string
  detail: Record<string, unknown>
}

const Tables = {
  payments: () => process.env.TABLE_PAYMENTS!,
  invoices: () => process.env.TABLE_INVOICES!,
  quotes: () => process.env.TABLE_QUOTES!,
  quotesConfig: () => process.env.TABLE_QUOTESCONFIG!,
  bookings: () => process.env.TABLE_BOOKINGS!,
}
const CHAT = 'https://chat.makerbay.app'

export type PaymentKind = 'invoice' | 'quote_deposit' | 'booking_deposit'
export interface PaymentRow {
  tenantId: string
  paymentId: string
  kind: PaymentKind
  refId: string
  amountCents: number
  currency: string
  status: 'pending' | 'paid' | 'refunded'
  stripeSessionId?: string
  stripePaymentIntentId?: string
  contactId?: string
  customerEmail?: string
  description: string
  createdAt: string
  paidAt?: string
  refundedAt?: string
}

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export const handler = async (
  event: Event | StripeForwardedEvent,
): Promise<APIGatewayProxyResultV2 | void> => {
  // Stripe events, forwarded (signature-verified) by the billing webhook.
  if ('detail-type' in event) {
    if (event['detail-type'] === 'stripe.checkout.completed') await onCheckoutCompleted(event.detail)
    if (event['detail-type'] === 'stripe.account.updated') await onAccountUpdated(event.detail)
    return
  }

  const method = event.requestContext.http.method
  const path = event.rawPath
  try {
    if (path.startsWith('/v1/public/payments')) return await publicRoute(method, path, event)

    const ctx = event.requestContext.authorizer.lambda
    const tenantId = await resolveTenantId(ctx)
    if (!tenantId) return json(401, { error: 'unauthorized' })

    if (method === 'POST' && path === '/v1/payments/connect') return await startConnect(tenantId, event)
    if (method === 'GET' && path === '/v1/payments/connect') return await connectStatus(tenantId)
    if (method === 'GET' && path === '/v1/payments') return await list(tenantId)
    const refund = path.match(/^\/v1\/payments\/([0-9A-Z]{26})\/refund$/)
    if (method === 'POST' && refund) return await refundPayment(tenantId, refund[1])

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('payments error', { path, method, err })
    // A platform-key permissions gap is the operator's problem, and saying
    // so beats a mystery 500 (issue 63).
    if ((err as { code?: string }).code === 'more_permissions_required') {
      return json(503, {
        error: 'stripe_permissions',
        message: 'Payments setup is temporarily unavailable - our Stripe configuration is missing a permission and we are on it. Nothing is wrong with your account.',
      })
    }
    // Same honesty for the Connect platform-profile gate: until Stripe's
    // loss-liability acknowledgment is completed, account creation is
    // refused with a message naming their settings page.
    if (String((err as Error).message ?? '').includes('platform-profile')) {
      return json(503, {
        error: 'stripe_platform_profile',
        message: 'Payments setup is temporarily unavailable - our Stripe platform registration is still being finalised. Nothing is wrong with your account.',
      })
    }
    return json(500, { error: 'internal_error' })
  }
}

async function resolveTenantId(ctx: CallerContext): Promise<string> {
  if (ctx.keyId) return ctx.tenantId
  if (!ctx.userId) return ''
  return (await getUser(ctx.userId))?.tenantId ?? ''
}

const body = (event: Event): Record<string, unknown> => {
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

// ── Connect onboarding ───────────────────────────────────────────────────

const COUNTRIES = new Set(['AU', 'IN', 'US', 'GB', 'NZ', 'CA', 'SG', 'IE'])

async function startConnect(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const tenant = await getTenant(tenantId)
  if (!tenant) return json(404, { error: 'no_tenant' })
  const b = body(event)
  const s = await stripe()

  let accountId = tenant.stripeAccountId
  if (!accountId) {
    const country = COUNTRIES.has(String(b.country)) ? String(b.country) : 'AU'
    const account = await s.accounts.create({
      type: 'express',
      country,
      business_profile: { name: tenant.name },
      metadata: { tenantId },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    })
    accountId = account.id
    await setTenantConnect(tenantId, { stripeAccountId: accountId })
  }

  // A fresh link every time - they expire in minutes and are single-use.
  const link = await s.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    refresh_url: 'https://app.makerbay.app/payments?connect=refresh',
    return_url: 'https://app.makerbay.app/payments?connect=done',
  })
  return json(200, { url: link.url })
}

async function connectStatus(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const tenant = await getTenant(tenantId)
  if (!tenant?.stripeAccountId) {
    return json(200, { connected: false, payoutsEnabled: false })
  }
  // Accounts change state out-of-band (documents reviewed, bank verified), so
  // status is refreshed from Stripe on read, not trusted from our row.
  const s = await stripe()
  const account = await s.accounts.retrieve(tenant.stripeAccountId)
  const payoutsEnabled = account.payouts_enabled === true && account.charges_enabled === true
  if (payoutsEnabled !== Boolean(tenant.payoutsEnabled)) {
    await setTenantConnect(tenantId, {
      payoutsEnabled,
      connectOnboardedAt: payoutsEnabled ? new Date().toISOString() : undefined,
    })
  }
  return json(200, {
    connected: true,
    payoutsEnabled,
    detailsSubmitted: account.details_submitted === true,
    // What Stripe still needs, so the dashboard can say it plainly.
    requirementsDue: account.requirements?.currently_due ?? [],
  })
}

// ── Payments list + refund ───────────────────────────────────────────────

async function allPayments(tenantId: string): Promise<PaymentRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.payments(),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
      ScanIndexForward: false,
      Limit: 200,
    }),
  )
  return (r.Items ?? []) as PaymentRow[]
}

async function list(tenantId: string): Promise<APIGatewayProxyResultV2> {
  return json(200, { payments: await allPayments(tenantId) })
}

async function refundPayment(tenantId: string, paymentId: string): Promise<APIGatewayProxyResultV2> {
  const r = await ddb.send(
    new GetCommand({ TableName: Tables.payments(), Key: { tenantId, paymentId } }),
  )
  const payment = r.Item as PaymentRow | undefined
  if (!payment) return json(404, { error: 'not_found' })
  if (payment.status !== 'paid') return json(409, { error: 'not_refundable', message: 'Only a paid payment can be refunded.' })
  if (!payment.stripePaymentIntentId) return json(409, { error: 'no_payment_intent' })

  const s = await stripe()
  // Full refund only in v1. The transfer is reversed so the connected
  // account funds the refund, as the money went to them.
  await s.refunds.create({
    payment_intent: payment.stripePaymentIntentId,
    reverse_transfer: true,
  })
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.payments(),
      Key: { tenantId, paymentId },
      UpdateExpression: 'SET #st = :s, refundedAt = :now',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':s': 'refunded', ':now': new Date().toISOString() },
    }),
  )
  if (payment.contactId) {
    await appendContactEvent(tenantId, payment.contactId, {
      moduleId: 'payments',
      title: `Refunded ${payment.description}`,
    })
  }
  await emitUsage({ tenantId, moduleId: 'payments', metric: 'payment.refunded', quantity: 1 })
  return json(200, { refunded: paymentId })
}

// ── Public: create a Checkout Session ────────────────────────────────────

async function publicRoute(method: string, path: string, event: Event): Promise<APIGatewayProxyResultV2> {
  if (method !== 'POST' || path !== '/v1/public/payments/session') return json(404, { error: 'not_found' })
  const b = body(event)
  const slug = String(b.slug ?? '')
  const kind = String(b.kind ?? '') as PaymentKind
  const token = String(b.token ?? '')
  if (!slug || !token || !['invoice', 'quote_deposit', 'booking_deposit'].includes(kind)) return json(400, { error: 'bad_request' })

  const tenant = await getTenantBySlug(slug)
  if (!tenant) return json(404, { error: 'not_found' })
  if (!tenant.stripeAccountId || !tenant.payoutsEnabled) {
    return json(409, { error: 'payments_not_set_up', message: 'This business does not take online payment yet.' })
  }

  const target = kind === 'invoice'
    ? await invoiceTarget(tenant.tenantId, token)
    : kind === 'quote_deposit'
      ? await quoteDepositTarget(tenant.tenantId, token)
      : await bookingDepositTarget(tenant.tenantId, token)
  if ('error' in target) return json(target.status, { error: target.error, message: target.message })

  // One open session per document: an unexpired pending payment is reused
  // rather than letting double-clicks mint parallel sessions.
  const existing = (await allPayments(tenant.tenantId)).find(
    (p) => p.refId === target.refId && p.kind === kind && p.status === 'paid',
  )
  if (existing) return json(409, { error: 'already_paid', message: 'This has already been paid.' })

  const s = await stripe()
  const paymentId = ulid()
  const page = kind === 'invoice' ? 'invoice' : kind === 'quote_deposit' ? 'quote' : 'booking'
  const returnUrl = `${CHAT}/${page}?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`
  const session = await s.checkout.sessions.create({
    mode: 'payment',
    // Booking deposits hold a diary slot for 35 minutes; the session must
    // die first (30 min is Stripe's floor) so a payment can never complete
    // against a freed slot.
    ...(kind === 'booking_deposit' ? { expires_at: Math.floor(Date.now() / 1000) + 1800 } : {}),
    line_items: [
      {
        price_data: {
          currency: target.currency.toLowerCase(),
          product_data: { name: target.description },
          unit_amount: target.amountCents,
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      transfer_data: { destination: tenant.stripeAccountId },
      on_behalf_of: tenant.stripeAccountId,
      metadata: { tenantId: tenant.tenantId, paymentId, kind, refId: target.refId },
    },
    metadata: { tenantId: tenant.tenantId, paymentId, kind, refId: target.refId },
    customer_email: target.customerEmail,
    success_url: `${returnUrl}&paid=pending`,
    cancel_url: returnUrl,
  })

  const now = new Date().toISOString()
  const row: PaymentRow = {
    tenantId: tenant.tenantId,
    paymentId,
    kind,
    refId: target.refId,
    amountCents: target.amountCents,
    currency: target.currency,
    status: 'pending',
    stripeSessionId: session.id,
    contactId: target.contactId,
    customerEmail: target.customerEmail,
    description: target.description,
    createdAt: now,
  }
  await ddb.send(new PutCommand({ TableName: Tables.payments(), Item: row }))
  return json(200, { url: session.url })
}

interface Target {
  refId: string
  amountCents: number
  currency: string
  description: string
  contactId?: string
  customerEmail?: string
}

// Mirrors the quotes module's document labels (SP-INV-001) so the Stripe
// statement line matches the paperwork the customer is holding.
const docLabel = (kind: 'Q' | 'INV', number: number, prefix = ''): string =>
  `${prefix ? `${prefix}-` : ''}${kind}-${String(number).padStart(3, '0')}`

async function tenantDocPrefix(tenantId: string): Promise<string> {
  const cfg = await ddb.send(
    new GetCommand({ TableName: Tables.quotesConfig(), Key: { tenantId } }),
  )
  return String(cfg.Item?.docPrefix ?? '')
}
type TargetError = { error: string; message: string; status: number }

async function invoiceTarget(tenantId: string, token: string): Promise<Target | TargetError> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.invoices(),
      KeyConditionExpression: 'tenantId = :t',
      FilterExpression: 'publicToken = :tok',
      ExpressionAttributeValues: { ':t': tenantId, ':tok': token },
      Limit: 200,
    }),
  )
  const invoice = (r.Items ?? [])[0]
  if (!invoice || invoice.status === 'draft') return { error: 'not_found', message: 'Invoice not found.', status: 404 }
  if (invoice.status === 'paid') return { error: 'already_paid', message: 'This invoice is already paid.', status: 409 }
  if (invoice.status === 'void') return { error: 'invoice_void', message: 'This invoice was voided.', status: 409 }
  return {
    refId: String(invoice.invoiceId),
    amountCents: Number(invoice.totalCents),
    currency: String(invoice.currency ?? 'AUD'),
    description: `Invoice ${docLabel('INV', Number(invoice.number), await tenantDocPrefix(tenantId))}`,
    contactId: invoice.contactId ? String(invoice.contactId) : undefined,
    customerEmail: invoice.customerEmail ? String(invoice.customerEmail) : undefined,
  }
}

/**
 * A held booking awaiting its deposit (spec-booking-deposits.md). The token
 * is the booking's cancelToken; the amount was stamped onto the row at
 * create time, so a service edited mid-flight cannot reprice the hold.
 */
async function bookingDepositTarget(tenantId: string, token: string): Promise<Target | TargetError> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.bookings(),
      FilterExpression: 'cancelToken = :tok',
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId, ':tok': token },
      Limit: 500,
    }),
  )
  const booking = (r.Items ?? [])[0]
  if (!booking) return { error: 'not_found', message: 'Booking not found.', status: 404 }
  if (booking.depositPaidAt)
    return { error: 'already_paid', message: 'This deposit has already been paid.', status: 409 }
  if (booking.status !== 'pending_payment')
    return { error: 'not_payable', message: 'This booking does not need a deposit.', status: 409 }
  if (new Date(String(booking.holdExpiresAt ?? 0)).getTime() < Date.now())
    return { error: 'hold_expired', message: 'That time was released - pick a slot again.', status: 409 }
  const cfg = await ddb.send(new GetCommand({ TableName: Tables.quotesConfig(), Key: { tenantId } }))
  const day = new Date(String(booking.startsAt)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
  return {
    refId: String(booking.bookingId),
    amountCents: Number(booking.depositCents),
    currency: String(cfg.Item?.currency ?? 'AUD'),
    description: `Deposit - ${booking.serviceName}, ${day}`,
    contactId: booking.contactId ? String(booking.contactId) : undefined,
    customerEmail: booking.email ? String(booking.email) : undefined,
  }
}

async function quoteDepositTarget(tenantId: string, token: string): Promise<Target | TargetError> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.quotes(),
      KeyConditionExpression: 'tenantId = :t',
      FilterExpression: 'publicToken = :tok',
      ExpressionAttributeValues: { ':t': tenantId, ':tok': token },
      Limit: 200,
    }),
  )
  const quote = (r.Items ?? [])[0]
  if (!quote) return { error: 'not_found', message: 'Quote not found.', status: 404 }
  if (quote.status !== 'accepted') {
    return { error: 'quote_not_accepted', message: 'A deposit follows acceptance - accept the quote first.', status: 409 }
  }
  const cfg = await ddb.send(
    new GetCommand({ TableName: Tables.quotesConfig(), Key: { tenantId } }),
  )
  const pct = Number(cfg.Item?.depositPercent ?? 0)
  if (!(pct > 0)) return { error: 'no_deposit', message: 'This business does not take deposits online.', status: 409 }
  const amountCents = Math.round(Number(quote.totalCents) * Math.min(pct, 100) / 100)
  if (amountCents < 100) return { error: 'amount_too_small', message: 'The deposit is too small to charge.', status: 409 }
  return {
    refId: String(quote.quoteId),
    amountCents,
    currency: String(quote.currency ?? 'AUD'),
    description: `Deposit (${pct}%) on quote ${docLabel('Q', Number(quote.number), String(cfg.Item?.docPrefix ?? ''))}`,
    contactId: quote.contactId ? String(quote.contactId) : undefined,
    customerEmail: quote.customerEmail ? String(quote.customerEmail) : undefined,
  }
}

// ── Stripe event fulfilment ──────────────────────────────────────────────

async function onCheckoutCompleted(detail: Record<string, unknown>): Promise<void> {
  const metadata = (detail.metadata ?? {}) as Record<string, string>
  const { tenantId, paymentId } = metadata
  if (!tenantId || !paymentId) {
    // Not one of ours (billing checkout, or foreign session) - ignore.
    return
  }
  const paymentIntent = typeof detail.payment_intent === 'string' ? detail.payment_intent : undefined

  // Idempotent claim: Stripe retries webhooks, and only the first delivery
  // may emit the domain event that marks documents paid.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: Tables.payments(),
        Key: { tenantId, paymentId },
        ConditionExpression: '#st = :pending',
        UpdateExpression: 'SET #st = :paid, paidAt = :now, stripePaymentIntentId = :pi',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':pending': 'pending',
          ':paid': 'paid',
          ':now': new Date().toISOString(),
          ':pi': paymentIntent ?? '',
        },
      }),
    )
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return
    throw err
  }

  const r = await ddb.send(
    new GetCommand({ TableName: Tables.payments(), Key: { tenantId, paymentId } }),
  )
  const payment = r.Item as PaymentRow | undefined
  if (!payment) return

  if (payment.contactId) {
    await appendContactEvent(tenantId, payment.contactId, {
      moduleId: 'payments',
      title: `Paid ${payment.description} - ${(payment.amountCents / 100).toFixed(2)} ${payment.currency}`,
    })
  }
  await emitUsage({ tenantId, moduleId: 'payments', metric: 'payment.received', quantity: 1 })
  // The owning module reacts: quotes marks the invoice paid, etc.
  await emitEvent('payments', 'payment.received', {
    tenantId,
    paymentId,
    kind: payment.kind,
    refId: payment.refId,
    amountCents: payment.amountCents,
    currency: payment.currency,
    contactId: payment.contactId,
  })
}

async function onAccountUpdated(detail: Record<string, unknown>): Promise<void> {
  const accountId = typeof detail.id === 'string' ? detail.id : undefined
  if (!accountId) return
  const metadata = (detail.metadata ?? {}) as Record<string, string>
  const tenant = metadata.tenantId
    ? await getTenant(metadata.tenantId)
    : await getTenantByStripeAccount(accountId)
  if (!tenant || tenant.stripeAccountId !== accountId) return

  const payoutsEnabled = detail.payouts_enabled === true && detail.charges_enabled === true
  if (payoutsEnabled !== Boolean(tenant.payoutsEnabled)) {
    await setTenantConnect(tenant.tenantId, {
      payoutsEnabled,
      connectOnboardedAt: payoutsEnabled ? new Date().toISOString() : undefined,
    })
    console.log('connect payouts state changed', { tenantId: tenant.tenantId, payoutsEnabled })
  }
}
