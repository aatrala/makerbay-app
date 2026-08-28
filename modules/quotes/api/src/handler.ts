import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import {
  appendContactEvent,
  emitUsage,
  findApiKeyByHash,
  getContact,
  getEffectiveEntitlement,
  getTenant,
  getTenantBySlugOrAlias,
  getUser,
  hashApiKey,
  json,
  linkToken,
  money,
  requireScope,
  sendEmail,
  ulid,
  upsertContact,
  type CallerContext,
} from '@makerbay/core'
import {
  INVOICE_THEMES,
  getInvoice,
  invoiceFromQuote,
  documentLogo,
  businessPhone,
  invoiceLabel,
  quoteLabel,
  listInvoices,
  patchInvoice,
  invoiceUrl,
  publicInvoiceView,
  revokeInvoiceLink,
  sendInvoice,
  shareInvoice,
} from './invoices'
import { docUrl } from './links'
import { documentInsights } from './insights'
import { docQr } from './qr'
import { claimAcceptFailure } from '@makerbay/core'
import {
  affirmationFor,
  callerIp,
  documentHash,
  effectiveCheck,
  lastFour,
  snapshotOf,
  verifyAccept,
} from './accept'
import {
  DEFAULT_QUOTES_CONFIG,
  computeTotals,
  countQuoteView,
  deletePriceItem,
  effectiveStatus,
  findByToken,
  getQuote,
  getQuotesConfig,
  listPriceItems,
  listQuotes,
  nextQuoteNumber,
  putPriceItem,
  putQuote,
  putQuotesConfig,
  type AcceptanceRecord,
  type PriceItemRow,
  type QuoteLine,
  type QuoteRow,
  type QuoteStatus,
} from './db'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

interface PaymentReceivedEvent {
  'detail-type': string
  detail: {
    tenantId: string
    paymentId: string
    kind: 'invoice' | 'quote_deposit'
    refId: string
    amountCents: number
    currency: string
    contactId?: string
  }
}

const APP = 'https://app.makerbay.app'
const STATUSES: QuoteStatus[] = ['draft', 'sent', 'accepted', 'declined', 'expired', 'superseded']

export const handler = async (
  event: Event | PaymentReceivedEvent,
): Promise<APIGatewayProxyResultV2 | void> => {
  // A payment landed (verified webhook → payments module → bus). The money
  // is fact; this branch makes the documents agree with it.
  if ('detail-type' in event) {
    if (event['detail-type'] === 'payment.received') await onPaymentReceived(event.detail)
    return
  }

  const method = event.requestContext.http.method
  const path = event.rawPath

  try {
    if (path.startsWith('/v1/public/quotes')) return await publicRoute(method, path, event)

    const ctx = event.requestContext.authorizer.lambda
    const tenantId = await resolveTenantId(ctx)
    if (!tenantId) return json(401, { error: 'unauthorized' })

    const entitlement = await getEffectiveEntitlement(tenantId, 'quotes')
    if (!entitlement.enabled) return json(403, { error: 'module_not_enabled' })

    if (method === 'GET' && path === '/v1/quotes/config') {
      return json(200, { config: await getQuotesConfig(tenantId) })
    }
    if (method === 'PUT' && path === '/v1/quotes/config') {
      const denied = requireScope(ctx, 'quotes:config:write')
      if (denied) return denied
      return await updateConfig(tenantId, event)
    }

    // How the documents are doing, for the Usage screen (issue 119).
    if (method === 'GET' && path === '/v1/quotes/insights') {
      return await documentInsights(tenantId)
    }

    if (method === 'GET' && path === '/v1/quotes/items') {
      return json(200, { items: await listPriceItems(tenantId) })
    }
    if (method === 'POST' && path === '/v1/quotes/items') return await createItem(tenantId, event)

    const item = path.match(/^\/v1\/quotes\/items\/([0-9A-Z]{26})$/)
    if (method === 'DELETE' && item) {
      await deletePriceItem(tenantId, item[1])
      return json(200, { deleted: item[1] })
    }

    if (method === 'GET' && path === '/v1/quotes') return await index(tenantId, event)
    if (method === 'POST' && path === '/v1/quotes') return await create(tenantId, event)

    const one = path.match(/^\/v1\/quotes\/([0-9A-Z]{26})$/)
    if (method === 'GET' && one) return await detail(tenantId, one[1])
    if (method === 'PATCH' && one) return await patch(tenantId, one[1], event)

    const send = path.match(/^\/v1\/quotes\/([0-9A-Z]{26})\/send$/)
    if (method === 'POST' && send) return await sendQuote(tenantId, send[1])

    // Sharing needs no email address (issue 118).
    const share = path.match(/^\/v1\/quotes\/([0-9A-Z]{26})\/share$/)
    if (method === 'POST' && share) return await shareQuote(tenantId, share[1])

    const revoke = path.match(/^\/v1\/quotes\/([0-9A-Z]{26})\/revoke$/)
    if (method === 'POST' && revoke) return await revokeQuoteLink(tenantId, revoke[1])

    const revise = path.match(/^\/v1\/quotes\/([0-9A-Z]{26})\/revise$/)
    if (method === 'POST' && revise) return await reviseQuote(tenantId, revise[1])

    const toInvoice = path.match(/^\/v1\/quotes\/([0-9A-Z]{26})\/invoice$/)
    if (method === 'POST' && toInvoice) return await createInvoice(tenantId, toInvoice[1])

    if (method === 'GET' && path === '/v1/quotes/invoices') {
      const cfg = await getQuotesConfig(tenantId)
      return json(200, {
        invoices: (await listInvoices(tenantId)).map((i) => ({
          ...i,
          label: invoiceLabel(i, cfg.docPrefix),
        })),
      })
    }
    const inv = path.match(/^\/v1\/quotes\/invoices\/([0-9A-Z]{26})$/)
    if (method === 'GET' && inv) return await invoiceDetail(tenantId, inv[1])
    if (method === 'PATCH' && inv) return await patchInvoice(tenantId, inv[1], body(event))
    const invSend = path.match(/^\/v1\/quotes\/invoices\/([0-9A-Z]{26})\/send$/)
    if (method === 'POST' && invSend) return await sendInvoice(tenantId, invSend[1])
    const invShare = path.match(/^\/v1\/quotes\/invoices\/([0-9A-Z]{26})\/share$/)
    if (method === 'POST' && invShare) return await shareInvoice(tenantId, invShare[1])
    const invRevoke = path.match(/^\/v1\/quotes\/invoices\/([0-9A-Z]{26})\/revoke$/)
    if (method === 'POST' && invRevoke) return await revokeInvoiceLink(tenantId, invRevoke[1])

    return json(404, { error: 'not_found' })
  } catch (err) {
    // The path carries the public token on every customer-facing route, and a
    // token is a bearer credential: anyone holding it can read the quote and
    // accept it. Logging the raw path put those in CloudWatch on every error.
    // The shape is enough to find the route; the secret segment is not.
    console.error('quotes error', { path: redactPath(path), method, err })
    return json(500, { error: 'internal_error' })
  }
}

async function resolveTenantId(ctx: CallerContext): Promise<string> {
  if (ctx.keyId) return ctx.tenantId
  if (!ctx.userId) return ''
  return (await getUser(ctx.userId))?.tenantId ?? ''
}

/**
 * A path safe to log. Public routes carry the quote or invoice token as a path
 * segment, and that token is a bearer credential - it is the only thing
 * standing between a stranger and the customer's price. Keep the route shape,
 * drop the secret.
 */
export const redactPath = (path: string): string =>
  String(path ?? '').replace(
    // Only a segment shaped like a token, so the literal route names on this
    // prefix (/v1/public/quotes/invoice) stay readable in the log.
    /\/v1\/public\/quotes\/[A-Za-z0-9_-]{20,}/g,
    '/v1/public/quotes/{token}',
  )

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

// ── Public surface: the customer's quote link ────────────────────────────

async function resolvePublicTenant(key?: string, slug?: string) {
  if (key) {
    if (!key.startsWith('mb_pk_')) return undefined
    const found = await findApiKeyByHash(hashApiKey(key))
    // Revoking a key deletes its row, so a missing lookup IS the revocation
    // check. Secret keys are refused: a public page must never present one.
    if (!found || found.type !== 'publishable') return undefined
    const tenant = await getTenant(found.tenantId)
    return tenant
      ? {
          tenantId: tenant.tenantId,
          name: tenant.name,
          // The PRIMARY slug, not whatever address was used to get here. A
          // link opened under an old alias should hand out a square for the
          // current address (issue 119).
          slug: tenant.slug,
          payoutsEnabled: Boolean(tenant.payoutsEnabled),
        }
      : undefined
  }
  if (slug) {
    /**
     * The alias fallback quotes never had (issue 118).
     *
     * Presence has honoured aliases since it shipped; quotes and invoices
     * looked up the primary slug only, so a workspace rename 404d every link
     * already in a customer's messages. Presence 301s to the primary because
     * it is canonicalising an indexed page - here we SERVE, because a
     * redirect is one more hop inside a link-preview crawler's short timeout,
     * and there is nothing to canonicalise on a noindex document.
     */
    const tenant = await getTenantBySlugOrAlias(slug)
    return tenant
      ? {
          tenantId: tenant.tenantId,
          name: tenant.name,
          // The PRIMARY slug, not whatever address was used to get here. A
          // link opened under an old alias should hand out a square for the
          // current address (issue 119).
          slug: tenant.slug,
          payoutsEnabled: Boolean(tenant.payoutsEnabled),
        }
      : undefined
  }
  return undefined
}


async function publicRoute(
  method: string,
  path: string,
  event: Event,
): Promise<APIGatewayProxyResultV2> {
  const b = method === 'POST' ? body(event) : {}
  const q = event.queryStringParameters ?? {}
  const resolved = await resolvePublicTenant(
    String(q.key ?? b.key ?? '') || undefined,
    String(q.slug ?? b.slug ?? '') || undefined,
  )
  if (!resolved) return json(404, { error: 'not_found' })

  if (method === 'GET' && path === '/v1/public/quotes/invoice') {
    return publicInvoiceView(
      resolved.tenantId, resolved.name, String(q.token ?? ''), resolved.payoutsEnabled, resolved.slug,
    )
  }

  const match = path.match(/^\/v1\/public\/quotes\/([A-Za-z0-9_-]{20,})(\/respond)?$/)
  if (!match) return json(404, { error: 'not_found' })

  // The token is the credential. It grants view and respond on one quote and
  // nothing else, which is why it is random rather than derived from the id.
  const quote = await findByToken(resolved.tenantId, match[1])
  if (!quote || quote.status === 'draft') return json(404, { error: 'not_found' })

  const config = await getQuotesConfig(resolved.tenantId)
  const status = effectiveStatus(quote)

  if (method === 'GET' && !match[2]) {
    // An accepted quote with a configured deposit and an onboarded Stripe
    // account offers payment. depositPaidAt on the row is the paid check -
    // written by the payment.received branch, never by a button press.
    const pct = Number((config as { depositPercent?: number }).depositPercent ?? 0)
    const depositPaid = Boolean((quote as { depositPaidAt?: string }).depositPaidAt)
    const deposit = status === 'accepted' && pct > 0
      ? {
          percent: pct,
          amountCents: Math.round(quote.totalCents * Math.min(pct, 100) / 100),
          paid: depositPaid,
          payable: resolved.payoutsEnabled && !depositPaid,
        }
      : null
    // Counted here and never at the CDN. A link preview bot fetches the page
    // shell to build its card the instant the message is sent, so a CDN-level
    // count would tell the owner "opened" before the customer had touched it,
    // and a dashboard that lies is worse than one that says nothing. This
    // endpoint is called by the page's own JavaScript, which bots do not run.
    await recordView(resolved.tenantId, quote)

    const check = effectiveCheck(config.acceptCheck ?? 'name', quote)
    /**
     * The scannable square, only while there is something to scan FOR.
     *
     * A settled quote is history: re-sharing it hands out a credential that
     * can no longer be revoked (revoke is refused once accepted or declined)
     * for a document nobody can act on. A superseded one is worse - its page
     * carries a link to the SUCCESSOR's token, and that must never become
     * machine-readable.
     */
    const qr = status === 'sent'
      ? await docQr(quoteUrl(resolved.slug, quoteLabel(quote.number, config.docPrefix), quote.publicToken))
      : undefined
    return json(200, {
      business: resolved.name,
      footer: config.docFooter || undefined,
      logoUrl: await documentLogo(resolved.tenantId, config),
      // For the printed sheet, where there is otherwise no way to reach them.
      ...(await businessPhone(resolved.tenantId).then((p) => (p ? { phone: p } : {}))),
      quote: { ...publicView(quote, status, config.taxLabel, config.docPrefix), deposit },
      // What the customer must do to accept, and the wording they will be
      // agreeing to. Sent with the document so the page cannot invent either.
      accept: {
        check,
        affirmation: affirmationFor(resolved.name, money(quote.totalCents, quote.currency)),
        ...(check === 'phone4' ? { phoneHint: phoneHintOf(quote.customerPhone) } : {}),
      },
      ...(qr ? { qr } : {}),
    })
  }

  if (method === 'POST' && match[2]) {
    return await respond(
      resolved.tenantId, resolved.name, quote, status, String(b.decision ?? ''), b, event,
    )
  }
  return json(404, { error: 'not_found' })
}

/**
 * "the number ending 5678", so the customer knows which phone is being asked
 * about without the page republishing the whole number to whoever holds the
 * link.
 */
const phoneHintOf = (phone?: string): string | undefined => {
  const four = lastFour(phone)
  return four ? `the number ending ${four}` : undefined
}

/**
 * Note that the customer opened it.
 *
 * The only delivery signal there is once email is out of the loop. Failing to
 * record a view must never cost the customer their page, so this swallows.
 */
async function recordView(tenantId: string, quote: QuoteRow): Promise<void> {
  try {
    await countQuoteView(tenantId, quote.quoteId, new Date().toISOString())
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return
    console.warn('view count failed', { tenantId, quoteId: quote.quoteId, err: String(err) })
  }
}

const publicView = (q: QuoteRow, status: QuoteStatus, taxLabel: string, docPrefix = '') => ({
  supersededBy: q.supersededByToken ?? null,
  number: q.number,
  label: quoteLabel(q.number, docPrefix),
  status,
  lines: q.lines,
  subtotalCents: q.subtotalCents,
  taxCents: q.taxCents,
  taxLabel,
  totalCents: q.totalCents,
  currency: q.currency,
  notes: q.notes,
  terms: q.terms,
  validUntil: q.validUntil,
  customerName: q.customerName,
})

/**
 * Whether this quote may be answered at all, and why not.
 *
 * Pure and exported so the rules can be tested without a database: an
 * acceptance is a contract, and every branch here decides whether one gets
 * recorded. Returns the response to send, or undefined to carry on.
 */
export function respondGuard(
  quote: Pick<QuoteRow, 'status' | 'supersededByToken'>,
  status: QuoteStatus,
  decision: string,
): APIGatewayProxyResultV2 | undefined {
  // Customers double-tap. A second accept returns the same answer rather than
  // recording a second acceptance.
  if (quote.status === 'accepted' || quote.status === 'declined') {
    return json(200, { status: quote.status, already: true })
  }
  // A superseded quote must not be acceptable. Revising sends the customer a
  // new link, but the OLD one is still sitting in their messages, and without
  // this a tap on it recorded a binding acceptance AT THE OLD PRICE. They keep
  // read access to what they were sent; they just cannot agree to a version
  // the business has withdrawn.
  //
  // Checked before expiry, because "this was replaced, here is the new one" is
  // a more useful answer than "this expired" when both are true.
  if (quote.status === 'superseded' || status === 'superseded') {
    return json(409, {
      error: 'superseded',
      message: 'This quote was replaced by a newer one. Open the latest version to accept it.',
      ...(quote.supersededByToken ? { supersededByToken: quote.supersededByToken } : {}),
    })
  }
  if (status === 'expired') {
    return json(409, {
      error: 'expired',
      message: 'This quote has expired. Ask for an updated one.',
    })
  }
  if (decision !== 'accept' && decision !== 'decline') return json(400, { error: 'bad_decision' })
  return undefined
}

async function respond(
  tenantId: string,
  businessName: string,
  quote: QuoteRow,
  status: QuoteStatus,
  decision: string,
  b: Record<string, unknown>,
  event: Event,
): Promise<APIGatewayProxyResultV2> {
  const denied = respondGuard(quote, status, decision)
  if (denied) return denied

  const config = await getQuotesConfig(tenantId)
  const accepted = decision === 'accept'
  const check = effectiveCheck(config.acceptCheck ?? 'name', quote)

  /**
   * The gate sits on ACCEPTING, never on viewing.
   *
   * Anyone the link was forwarded to can read the price - that is the point of
   * a link, and the customer showing it to their partner is the behaviour we
   * want. Agreeing to it is a different act, and only that one is checked.
   *
   * Declining is not gated: someone who wants to say no should never be made
   * to prove who they are first, and a wrongly-declined quote is recoverable
   * by a phone call in a way a wrongly-accepted one is not.
   */
  let acceptance: AcceptanceRecord | undefined
  if (accepted) {
    const failed = verifyAccept(check, quote, {
      name: String(b.name ?? ''),
      phone4: String(b.phone4 ?? ''),
    })
    if (failed) {
      /**
       * Wrong answers are counted, and after ten in an hour this document
       * stops listening (issue 119 review).
       *
       * The check being protected is the last four digits of a phone number:
       * 10,000 possibilities, which one script works through in minutes. Until
       * this, the STRONGER accept setting was the brute-forceable one, which
       * made it falsely reassuring. Success would have been recorded as a
       * binding contract with a name, an IP and a document hash.
       *
       * Keyed on the token rather than the caller's address, because someone
       * who can hold the link can also change address - a per-IP cap alone
       * would be theatre against exactly this attack.
       */
      const allowed = await claimAcceptFailure(quote.publicToken)
      if (!allowed.ok) {
        return json(429, {
          error: 'too_many_attempts',
          message: 'Too many tries. Wait an hour, or ask them to send the quote again.',
        })
      }
      return json(400, failed)
    }

    const snapshot = snapshotOf(quote)
    acceptance = {
      at: new Date().toISOString(),
      name: String(b.name ?? '').trim().slice(0, 120),
      ip: callerIp(event),
      userAgent: String(event.headers?.['user-agent'] ?? '').slice(0, 256) || undefined,
      // The wording is rebuilt here rather than trusted from the request: the
      // customer must be recorded as agreeing to what we showed, not to
      // whatever text a POST claimed was on screen.
      affirmation: affirmationFor(businessName, money(quote.totalCents, quote.currency)),
      check,
      documentHash: documentHash(snapshot),
      snapshot,
    }
  }

  const now = new Date().toISOString()
  const updated: QuoteRow = {
    ...quote,
    status: accepted ? 'accepted' : 'declined',
    acceptedAt: accepted ? now : undefined,
    declinedAt: accepted ? undefined : now,
    ...(acceptance ? { acceptance } : {}),
    updatedAt: now,
  }
  await putQuote(updated)

  const qLabel = quoteLabel(quote.number, config.docPrefix)
  await appendContactEvent(tenantId, quote.contactId, {
    moduleId: 'quotes',
    title: accepted
      ? `Accepted quote ${qLabel} for ${money(quote.totalCents, quote.currency)}`
      : `Declined quote ${qLabel}`,
    href: `/quotes/${quote.quoteId}`,
  })
  await sendEmail({
    to: config.notifyEmail || '',
    audience: 'owner' as const,
    ref: { tenantId, moduleId: 'quotes', refType: 'quote', refId: quote.quoteId },
    subject: `Quote ${qLabel} ${accepted ? 'accepted' : 'declined'}`,
    text: [
      `${quote.customerName ?? 'Your customer'} ${accepted ? 'accepted' : 'declined'} quote ${qLabel}.`,
      accepted ? `Total: ${money(quote.totalCents, quote.currency)}` : '',
      '',
      `${APP}/quotes/${quote.quoteId}`,
      '',
      businessName,
    ].join('\n'),
  })

  if (accepted) {
    await emitUsage({ tenantId, moduleId: 'quotes', metric: 'quote.accepted', quantity: 1 })
  }
  return json(200, { status: updated.status })
}

// ── Authenticated surface ────────────────────────────────────────────────

async function createItem(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const description = String(b.description ?? '').trim()
  if (description.length < 2) return json(400, { error: 'description_required' })

  const row: PriceItemRow = {
    tenantId,
    itemId: ulid(),
    description: description.slice(0, 200),
    unit: String(b.unit ?? 'item').slice(0, 20),
    unitCents: Math.max(0, Math.round(Number(b.unitCents ?? 0))),
    active: b.active !== false,
    createdAt: new Date().toISOString(),
  }
  await putPriceItem(row)
  return json(201, { item: row })
}

/** Lines arrive from the client; prices are re-derived so nothing is trusted. */
function normaliseLines(raw: unknown): QuoteLine[] {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, 60)
    .map((l) => {
      const line = l as Record<string, unknown>
      const quantity = Math.max(0, Number(line.quantity ?? 1))
      const unitCents = Math.max(0, Math.round(Number(line.unitCents ?? 0)))
      return {
        description: String(line.description ?? '').slice(0, 200),
        unit: String(line.unit ?? 'item').slice(0, 20),
        quantity: Number.isFinite(quantity) ? quantity : 0,
        unitCents,
        totalCents: 0,
      }
    })
    .filter((l) => l.description.length > 0)
}

async function create(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const config = await getQuotesConfig(tenantId)
  const lines = normaliseLines(b.lines)
  if (lines.length === 0) return json(400, { error: 'lines_required', message: 'Add at least one line.' })

  // The customer may come from an existing contact or straight from a request.
  let contactId = String(b.contactId ?? '')
  let customerName = String(b.customerName ?? '').trim()
  let customerEmail = String(b.customerEmail ?? '').trim()
  // The one identifier a tradesperson always has. Before issue 118 the form
  // took an email and nothing else, which meant the customers most likely to
  // be reached by text could not be quoted at all.
  let customerPhone = String(b.customerPhone ?? '').trim()

  if (contactId) {
    const contact = await getContact(tenantId, contactId)
    if (!contact) return json(404, { error: 'unknown_contact' })
    customerName = customerName || contact.name || ''
    customerEmail = customerEmail || contact.email || ''
    customerPhone = customerPhone || contact.phone || ''
  } else {
    if (!customerName && !customerEmail && !customerPhone) {
      return json(400, {
        error: 'customer_required',
        message: 'Pick a contact, or give a name with an email or phone number.',
      })
    }
    const contact = await upsertContact(tenantId, {
      name: customerName, email: customerEmail, phone: customerPhone, source: 'quotes',
    })
    contactId = contact.contactId
  }

  const totals = computeTotals({ lines, taxRate: config.taxRate })
  const now = new Date().toISOString()
  const validDays = Math.max(1, Number(b.validDays ?? config.validDays))

  const quote: QuoteRow = {
    tenantId,
    quoteId: ulid(),
    number: await nextQuoteNumber(tenantId),
    contactId,
    requestId: b.requestId ? String(b.requestId) : undefined,
    customerName: customerName || undefined,
    customerEmail: customerEmail || undefined,
    customerPhone: customerPhone || undefined,
    lines: lines.map((l, i) => ({ ...l, totalCents: totals.lineTotals[i] })),
    subtotalCents: totals.subtotalCents,
    taxRate: config.taxRate,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    currency: config.currency,
    notes: b.notes ? String(b.notes).slice(0, 2000) : undefined,
    terms: String(b.terms ?? config.terms).slice(0, 2000),
    status: 'draft',
    publicToken: linkToken(),
    validUntil: new Date(Date.now() + validDays * 86_400_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  }
  await putQuote(quote)
  return json(201, { quote })
}

async function index(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const q = event.queryStringParameters ?? {}
  const status = STATUSES.includes(q.status as QuoteStatus) ? (q.status as QuoteStatus) : undefined
  const rows = await listQuotes(tenantId, status)
  const config = await getQuotesConfig(tenantId)
  return json(200, {
    // Expiry is evaluated on read, so a quote lapses without a scheduled job.
    quotes: rows.map((r) => ({
      ...r,
      status: effectiveStatus(r),
      label: quoteLabel(r.number, config.docPrefix),
    })),
    config: {
      currency: config.currency,
      taxLabel: config.taxLabel,
      taxRate: config.taxRate,
      docPrefix: config.docPrefix,
    },
  })
}

async function detail(tenantId: string, quoteId: string): Promise<APIGatewayProxyResultV2> {
  const quote = await getQuote(tenantId, quoteId)
  if (!quote) return json(404, { error: 'not_found' })
  const config = await getQuotesConfig(tenantId)
  const tenant = await getTenant(tenantId)
  const label = quoteLabel(quote.number, config.docPrefix)
  return json(200, {
    quote: { ...quote, status: effectiveStatus(quote) },
    label,
    // A draft has no working link: the public page 404s on one. Offering it
    // anyway let a tradesperson copy a dead link and paste it in front of a
    // customer, which is exactly what sharing makes the normal path.
    publicUrl: quote.status === 'draft'
      ? undefined
      : quoteUrl(tenant?.slug ?? '', label, quote.publicToken),
    config: { currency: config.currency, taxLabel: config.taxLabel, docPrefix: config.docPrefix },
  })
}

async function patch(tenantId: string, quoteId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const existing = await getQuote(tenantId, quoteId)
  if (!existing) return json(404, { error: 'not_found' })

  // Editing an accepted quote would change what somebody already agreed to.
  if (existing.status === 'accepted' || existing.status === 'declined') {
    return json(409, {
      error: 'quote_settled',
      message: `Quote ${quoteLabel(existing.number)} has already been ${existing.status}. Create a new one instead.`,
    })
  }
  /**
   * Once a quote has left the building, editing it in place is a silent
   * re-price of a document the customer is already looking at. They could be
   * shown one total, accept it, and the row afterwards read another, with
   * nothing recording the difference.
   *
   * `revise` is the honest path: it writes a new numbered quote with its own
   * token and marks this one superseded, so both versions survive and the
   * customer is told which one is current.
   */
  if (existing.sentAt) {
    return json(409, {
      error: 'quote_already_sent',
      message:
        `Quote ${quoteLabel(existing.number)} is already with the customer, so it cannot be edited. `
        + 'Revise it instead - they get the new version and the old one stops being acceptable.',
    })
  }

  const config = await getQuotesConfig(tenantId)
  const lines = b.lines === undefined ? existing.lines : normaliseLines(b.lines)
  const totals = computeTotals({ lines, taxRate: config.taxRate })

  const quote: QuoteRow = {
    ...existing,
    lines: lines.map((l, i) => ({ ...l, totalCents: totals.lineTotals[i] })),
    subtotalCents: totals.subtotalCents,
    taxRate: config.taxRate,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    ...(b.notes !== undefined ? { notes: String(b.notes).slice(0, 2000) } : {}),
    ...(b.terms !== undefined ? { terms: String(b.terms).slice(0, 2000) } : {}),
    ...(b.validDays !== undefined
      ? { validUntil: new Date(Date.now() + Math.max(1, Number(b.validDays)) * 86_400_000).toISOString() }
      : {}),
    updatedAt: new Date().toISOString(),
  }
  await putQuote(quote)
  return json(200, { quote })
}

/** The customer's link for a quote. Built in exactly one place (./links). */
const quoteUrl = (slug: string, label: string, token: string): string =>
  docUrl('quote', slug, label, token)

/**
 * Mark a quote as out with the customer.
 *
 * Extracted from sendQuote because emailing was the ONLY way to reach this
 * state, and the link only renders once the quote leaves draft (issue 118).
 * A tradesperson holding nothing but a phone number could therefore create a
 * quote and never obtain its link at all - not a missing feature, a circular
 * dependency. Sharing is now the primitive; email is one way of doing it.
 */
async function markShared(
  tenantId: string,
  quote: QuoteRow,
  via: 'email' | 'link',
  label: string,
  notifyError?: string,
): Promise<QuoteRow> {
  const now = new Date().toISOString()
  const updated: QuoteRow = {
    ...quote,
    // Sending is what makes a quote real, even if the email bounced - the link
    // still works, and the owner can pass it on by hand.
    status: quote.status === 'draft' ? 'sent' : quote.status,
    sentAt: quote.sentAt ?? now,
    sharedVia: quote.sharedVia ?? via,
    updatedAt: now,
    notifyError,
  }
  await putQuote(updated)
  await appendContactEvent(tenantId, quote.contactId, {
    moduleId: 'quotes',
    // Says which channel, because with no email there is nothing else that can
    // answer "did this actually go out?" later.
    title: via === 'email'
      ? `Sent quote ${label} for ${money(quote.totalCents, quote.currency)}`
      : `Shared a link to quote ${label} for ${money(quote.totalCents, quote.currency)}`,
    href: `/quotes/${quote.quoteId}`,
  })
  await emitUsage({ tenantId, moduleId: 'quotes', metric: 'quote.sent', quantity: 1 })
  return updated
}

/**
 * Hand back the customer link without sending anything.
 *
 * The tradesperson passes it on however they like - a text, WhatsApp, or the
 * phone held out across a kitchen table. No email address required, which is
 * the entire point of issue 118.
 */
async function shareQuote(tenantId: string, quoteId: string): Promise<APIGatewayProxyResultV2> {
  const quote = await getQuote(tenantId, quoteId)
  if (!quote) return json(404, { error: 'not_found' })
  if (quote.status === 'superseded') {
    return json(409, {
      error: 'superseded',
      message: 'This quote was replaced by a newer one. Share that one instead.',
    })
  }

  const [tenant, config] = await Promise.all([getTenant(tenantId), getQuotesConfig(tenantId)])
  const label = quoteLabel(quote.number, config.docPrefix)
  const updated = await markShared(tenantId, quote, 'link', label)
  return json(200, {
    quote: updated,
    publicUrl: quoteUrl(tenant?.slug ?? '', label, quote.publicToken),
    label,
    emailed: false,
  })
}

/**
 * Kill a shared link and mint a new one.
 *
 * The honest answer to "I sent it to the wrong Dave", and the reason this
 * product does not need a view password: the realistic threat is a mis-sent
 * link, and no password in the same message would have stopped that anyway.
 * Anyone holding the old link now gets a not-found.
 */
async function revokeQuoteLink(tenantId: string, quoteId: string): Promise<APIGatewayProxyResultV2> {
  const quote = await getQuote(tenantId, quoteId)
  if (!quote) return json(404, { error: 'not_found' })
  // Rotating the token on a settled quote would strand the customer's own
  // record of what they agreed to, and there is nothing left to protect.
  if (quote.status === 'accepted' || quote.status === 'declined') {
    return json(409, {
      error: 'quote_settled',
      message: `Quote ${quoteLabel(quote.number)} has already been ${quote.status}, so its link cannot be changed.`,
    })
  }

  const [tenant, config] = await Promise.all([getTenant(tenantId), getQuotesConfig(tenantId)])
  const now = new Date().toISOString()
  const updated: QuoteRow = {
    ...quote,
    publicToken: linkToken(),
    tokenRotatedAt: now,
    updatedAt: now,
    // The new link has been seen by nobody. Carrying the old counts over would
    // tell the owner the customer had opened something they have never seen.
    firstViewedAt: undefined,
    lastViewedAt: undefined,
    viewCount: 0,
  }
  await putQuote(updated)
  const label = quoteLabel(quote.number, config.docPrefix)
  await appendContactEvent(tenantId, quote.contactId, {
    moduleId: 'quotes',
    title: `Stopped the old link to quote ${label} working`,
    href: `/quotes/${quote.quoteId}`,
  })
  return json(200, {
    quote: updated,
    publicUrl: quoteUrl(tenant?.slug ?? '', label, updated.publicToken),
    label,
  })
}

async function sendQuote(tenantId: string, quoteId: string): Promise<APIGatewayProxyResultV2> {
  const quote = await getQuote(tenantId, quoteId)
  if (!quote) return json(404, { error: 'not_found' })
  if (!quote.customerEmail) {
    return json(400, {
      error: 'no_customer_email',
      // Names the way out, because there now IS one.
      message: 'This customer has no email address. Share the link instead and send it however you like.',
    })
  }

  const tenant = await getTenant(tenantId)
  const config = await getQuotesConfig(tenantId)
  const qLabel = quoteLabel(quote.number, config.docPrefix)
  const url = quoteUrl(tenant?.slug ?? '', qLabel, quote.publicToken)

  const notice = await sendEmail({
    to: quote.customerEmail,
    ref: { tenantId, moduleId: 'quotes', refType: 'quote', refId: quote.quoteId },
    audience: 'customer' as const,
    fromName: tenant?.name ?? 'MakerBay',
    replyTo: config.notifyEmail ?? '',
    subject: `Quote ${qLabel} from ${tenant?.name ?? 'us'}`,
    text: [
      `${quote.customerName ?? 'Hello'},`,
      '',
      `Here is your quote for ${money(quote.totalCents, quote.currency)}.`,
      '',
      ...quote.lines.map(
        (l) => `  ${l.quantity} × ${l.description} — ${money(l.totalCents, quote.currency)}`,
      ),
      '',
      `Total: ${money(quote.totalCents, quote.currency)}`,
      `Valid until ${new Date(quote.validUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
      '',
      `View and accept: ${url}`,
      '',
      tenant?.name ?? '',
    ].join('\n'),
  })

  const updated = await markShared(
    tenantId, quote, 'email', qLabel, notice.sent ? undefined : notice.error,
  )

  return json(200, { quote: updated, publicUrl: url, emailed: notice.sent, emailError: notice.error })
}

/**
 * A new version of a settled or sent quote. The old quote never changes -
 * what somebody agreed to (or declined, or let lapse) stays exactly as it
 * was. The new draft copies the lines and the customer, gets its own number,
 * and the old public page points forward to it once this one is sent.
 */
async function reviseQuote(tenantId: string, quoteId: string): Promise<APIGatewayProxyResultV2> {
  const old = await getQuote(tenantId, quoteId)
  if (!old) return json(404, { error: 'not_found' })
  if (old.status === 'draft') {
    return json(409, { error: 'still_draft', message: 'This quote is still a draft - just edit it.' })
  }

  const now = new Date().toISOString()
  const config = await getQuotesConfig(tenantId)
  const fresh: QuoteRow = {
    ...old,
    quoteId: ulid(),
    number: await nextQuoteNumber(tenantId),
    status: 'draft',
    publicToken: linkToken(),
    validUntil: new Date(Date.now() + config.validDays * 86_400_000).toISOString(),
    createdAt: now,
    updatedAt: now,
    sentAt: undefined,
    acceptedAt: undefined,
    declinedAt: undefined,
    notifyError: undefined,
  }
  fresh.revisionOf = old.quoteId
  await putQuote(fresh)

  // A sent-but-unanswered quote is replaced; its page will say so. Settled
  // quotes (accepted/declined/expired) keep their status - they are history.
  if (old.status === 'sent') {
    await putQuote({
      ...old,
      status: 'superseded' as QuoteStatus,
      updatedAt: now,
      supersededByToken: fresh.publicToken,
    })
  } else {
    await putQuote({ ...old, updatedAt: now, supersededByToken: fresh.publicToken })
  }
  return json(201, { quote: fresh })
}

async function createInvoice(tenantId: string, quoteId: string): Promise<APIGatewayProxyResultV2> {
  const quote = await getQuote(tenantId, quoteId)
  if (!quote) return json(404, { error: 'not_found' })
  // One invoice per quote: a second click returns the invoice that already
  // exists instead of quietly minting a duplicate the customer could pay twice.
  if (quote.invoiceId) {
    const existing = await getInvoice(tenantId, quote.invoiceId)
    if (existing) return json(200, { invoice: existing, existing: true })
  }
  try {
    const invoice = await invoiceFromQuote(tenantId, quote)
    await putQuote({ ...quote, invoiceId: invoice.invoiceId, invoicedAt: invoice.createdAt, updatedAt: invoice.createdAt })
    return json(201, { invoice })
  } catch (err) {
    if ((err as { code?: string }).code === 'quote_not_accepted') {
      return json(409, {
        error: 'quote_not_accepted',
        message: 'An invoice comes from an accepted quote - the customer has to agree to the price first.',
      })
    }
    throw err
  }
}

async function invoiceDetail(tenantId: string, invoiceId: string): Promise<APIGatewayProxyResultV2> {
  const invoice = await getInvoice(tenantId, invoiceId)
  if (!invoice) return json(404, { error: 'not_found' })
  const tenant = await getTenant(tenantId)
  const config = await getQuotesConfig(tenantId)
  const label = invoiceLabel(invoice, config.docPrefix)
  return json(200, {
    invoice,
    label,
    // Same draft trap as quotes: the public invoice view 404s on a draft, and
    // the screen offered the link unconditionally.
    publicUrl: invoice.status === 'draft'
      ? undefined
      : invoiceUrl(tenant?.slug ?? '', label, invoice.publicToken),
  })
}

/**
 * Money landed (payments module, via the bus). Make the paperwork agree:
 * an invoice payment marks the invoice paid through the same path as the
 * manual button; a quote deposit is stamped onto the quote and the owner
 * is told. Idempotent - the payments module only emits once per payment.
 */
async function onPaymentReceived(detail: PaymentReceivedEvent['detail']): Promise<void> {
  const { tenantId, kind, refId } = detail
  if (!tenantId || !refId) return
  try {
    if (kind === 'invoice') {
      await patchInvoice(tenantId, refId, { status: 'paid' })
      return
    }
    if (kind === 'quote_deposit') {
      const quote = await getQuote(tenantId, refId)
      if (!quote) return
      await putQuote({
        ...quote,
        ...({ depositPaidAt: new Date().toISOString(), depositPaidCents: detail.amountCents } as Partial<QuoteRow>),
        updatedAt: new Date().toISOString(),
      })
      const config = await getQuotesConfig(tenantId)
      const qLabel = quoteLabel(quote.number, config.docPrefix)
      await appendContactEvent(tenantId, quote.contactId, {
        moduleId: 'quotes',
        title: `Paid the deposit on quote ${qLabel} - ${money(detail.amountCents, detail.currency)}`,
        href: `/quotes/${quote.quoteId}`,
      })
      await sendEmail({
        to: config.notifyEmail || '',
        audience: 'owner' as const,
        ref: { tenantId, moduleId: 'quotes', refType: 'quote', refId: quote.quoteId },
        subject: `Deposit paid on quote ${qLabel}`,
        text: [
          `${quote.customerName ?? 'Your customer'} paid the ${money(detail.amountCents, detail.currency)} deposit on quote ${qLabel}.`,
          '',
          `Quote: ${APP}/quotes/${quote.quoteId}`,
        ].join('\n'),
      })
    }
  } catch (err) {
    console.error('payment.received handling failed', { tenantId, kind, refId, err })
    throw err
  }
}

async function updateConfig(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const existing = await getQuotesConfig(tenantId)
  const config = {
    ...existing,
    tenantId,
    // A rate is a fraction, not a percentage: 0.1 is 10%.
    taxRate: Math.min(Math.max(Number(b.taxRate ?? existing.taxRate) || 0, 0), 1),
    taxLabel: String(b.taxLabel ?? existing.taxLabel).slice(0, 20),
    currency: /^[A-Z]{3}$/.test(String(b.currency)) ? String(b.currency) : existing.currency,
    terms: String(b.terms ?? DEFAULT_QUOTES_CONFIG.terms).slice(0, 2000),
    validDays: Math.min(Math.max(Number(b.validDays ?? existing.validDays) || 30, 1), 365),
    notifyEmail: String(b.notifyEmail ?? existing.notifyEmail).slice(0, 200),
    /**
     * What a customer must do to accept (issue 118).
     *
     * This was added to the type and the defaults and never to this function,
     * so the setting existed and could not be changed - phone4, the stronger
     * option, was unreachable from anywhere. Validated against the union
     * rather than trusted, because an unknown value here would fall through
     * verifyAccept's checks and gate nothing at all.
     */
    acceptCheck: (['none', 'name', 'phone4'] as const).includes(b.acceptCheck as never)
      ? (b.acceptCheck as 'none' | 'name' | 'phone4')
      : (existing.acceptCheck ?? 'name'),
    invoiceTheme: INVOICE_THEMES.includes(b.invoiceTheme as never)
      ? (b.invoiceTheme as string)
      : ((existing as { invoiceTheme?: string }).invoiceTheme ?? 'classic'),
    paymentInstructions: String(
      b.paymentInstructions ?? (existing as { paymentInstructions?: string }).paymentInstructions ?? '',
    ).slice(0, 1000),
    dueDays: Math.min(Math.max(Number(b.dueDays ?? (existing as { dueDays?: number }).dueDays ?? 14) || 14, 1), 90),
    // 0 means no deposit asked. Applies from the next acceptance.
    depositPercent: Math.min(
      Math.max(Number(b.depositPercent ?? (existing as { depositPercent?: number }).depositPercent ?? 0) || 0, 0),
      100,
    ),
    docFooter: String(b.docFooter ?? existing.docFooter ?? '').slice(0, 200),
    showLogoOnDocs: b.showLogoOnDocs === undefined
      ? existing.showLogoOnDocs
      : b.showLogoOnDocs === true,
    // The document tag: short, uppercase, letters and digits only. SP turns
    // Q-001 into SP-Q-001 on every new label; existing numbers are untouched.
    docPrefix: (() => {
      if (b.docPrefix === undefined) return existing.docPrefix ?? ''
      const p = String(b.docPrefix).trim().toUpperCase()
      return /^[A-Z0-9]{0,6}$/.test(p) ? p : (existing.docPrefix ?? '')
    })(),
  } as typeof existing
  await putQuotesConfig(config)
  return json(200, { config })
}
