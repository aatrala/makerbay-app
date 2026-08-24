import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import {
  appendContactEvent,
  emitUsage,
  findApiKeyByHash,
  getContact,
  getEffectiveEntitlement,
  getTenant,
  getTenantBySlug,
  getUser,
  hashApiKey,
  linkToken,
  money,
  sendEmail,
  ulid,
  upsertContact,
  type CallerContext,
} from '@makerbay/core'
import {
  DEFAULT_QUOTES_CONFIG,
  computeTotals,
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
  type PriceItemRow,
  type QuoteLine,
  type QuoteRow,
  type QuoteStatus,
} from './db'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const CHAT = 'https://chat.makerbay.app'
const APP = 'https://app.makerbay.app'
const STATUSES: QuoteStatus[] = ['draft', 'sent', 'accepted', 'declined', 'expired']

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
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
    if (method === 'PUT' && path === '/v1/quotes/config') return await updateConfig(tenantId, event)

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

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('quotes error', { path, method, err })
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

// ── Public surface: the customer's quote link ────────────────────────────

async function resolvePublicTenant(key?: string, slug?: string) {
  if (key) {
    if (!key.startsWith('mb_pk_')) return undefined
    const found = await findApiKeyByHash(hashApiKey(key))
    // Revoking a key deletes its row, so a missing lookup IS the revocation
    // check. Secret keys are refused: a public page must never present one.
    if (!found || found.type !== 'publishable') return undefined
    const tenant = await getTenant(found.tenantId)
    return tenant ? { tenantId: tenant.tenantId, name: tenant.name } : undefined
  }
  if (slug) {
    const tenant = await getTenantBySlug(slug)
    return tenant ? { tenantId: tenant.tenantId, name: tenant.name } : undefined
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

  const match = path.match(/^\/v1\/public\/quotes\/([A-Za-z0-9_-]{20,})(\/respond)?$/)
  if (!match) return json(404, { error: 'not_found' })

  // The token is the credential. It grants view and respond on one quote and
  // nothing else, which is why it is random rather than derived from the id.
  const quote = await findByToken(resolved.tenantId, match[1])
  if (!quote || quote.status === 'draft') return json(404, { error: 'not_found' })

  const config = await getQuotesConfig(resolved.tenantId)
  const status = effectiveStatus(quote)

  if (method === 'GET' && !match[2]) {
    return json(200, {
      business: resolved.name,
      quote: publicView(quote, status, config.taxLabel),
    })
  }

  if (method === 'POST' && match[2]) {
    return await respond(resolved.tenantId, resolved.name, quote, status, String(b.decision ?? ''))
  }
  return json(404, { error: 'not_found' })
}

const publicView = (q: QuoteRow, status: QuoteStatus, taxLabel: string) => ({
  number: q.number,
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

async function respond(
  tenantId: string,
  businessName: string,
  quote: QuoteRow,
  status: QuoteStatus,
  decision: string,
): Promise<APIGatewayProxyResultV2> {
  // Customers double-tap. A second accept returns the same answer rather than
  // recording a second acceptance.
  if (quote.status === 'accepted' || quote.status === 'declined') {
    return json(200, { status: quote.status, already: true })
  }
  if (status === 'expired') {
    return json(409, {
      error: 'expired',
      message: 'This quote has expired. Ask for an updated one.',
    })
  }
  if (decision !== 'accept' && decision !== 'decline') return json(400, { error: 'bad_decision' })

  const now = new Date().toISOString()
  const accepted = decision === 'accept'
  const updated: QuoteRow = {
    ...quote,
    status: accepted ? 'accepted' : 'declined',
    acceptedAt: accepted ? now : undefined,
    declinedAt: accepted ? undefined : now,
    updatedAt: now,
  }
  await putQuote(updated)

  const config = await getQuotesConfig(tenantId)
  await appendContactEvent(tenantId, quote.contactId, {
    moduleId: 'quotes',
    title: accepted
      ? `Accepted quote #${quote.number} for ${money(quote.totalCents, quote.currency)}`
      : `Declined quote #${quote.number}`,
    href: `/quotes/${quote.quoteId}`,
  })
  await sendEmail({
    to: config.notifyEmail || '',
    subject: `Quote #${quote.number} ${accepted ? 'accepted' : 'declined'}`,
    text: [
      `${quote.customerName ?? 'Your customer'} ${accepted ? 'accepted' : 'declined'} quote #${quote.number}.`,
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

  if (contactId) {
    const contact = await getContact(tenantId, contactId)
    if (!contact) return json(404, { error: 'unknown_contact' })
    customerName = customerName || contact.name || ''
    customerEmail = customerEmail || contact.email || ''
  } else {
    if (!customerName && !customerEmail) {
      return json(400, { error: 'customer_required', message: 'Pick a contact or give a name and email.' })
    }
    const contact = await upsertContact(tenantId, {
      name: customerName, email: customerEmail, source: 'quotes',
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
    quotes: rows.map((r) => ({ ...r, status: effectiveStatus(r) })),
    config: { currency: config.currency, taxLabel: config.taxLabel, taxRate: config.taxRate },
  })
}

async function detail(tenantId: string, quoteId: string): Promise<APIGatewayProxyResultV2> {
  const quote = await getQuote(tenantId, quoteId)
  if (!quote) return json(404, { error: 'not_found' })
  const config = await getQuotesConfig(tenantId)
  const tenant = await getTenant(tenantId)
  return json(200, {
    quote: { ...quote, status: effectiveStatus(quote) },
    publicUrl: `${CHAT}/quote?slug=${tenant?.slug ?? ''}&token=${quote.publicToken}`,
    config: { currency: config.currency, taxLabel: config.taxLabel },
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
      message: `Quote #${existing.number} has already been ${existing.status}. Create a new one instead.`,
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

async function sendQuote(tenantId: string, quoteId: string): Promise<APIGatewayProxyResultV2> {
  const quote = await getQuote(tenantId, quoteId)
  if (!quote) return json(404, { error: 'not_found' })
  if (!quote.customerEmail) {
    return json(400, { error: 'no_customer_email', message: 'This customer has no email address.' })
  }

  const tenant = await getTenant(tenantId)
  const config = await getQuotesConfig(tenantId)
  const url = `${CHAT}/quote?slug=${tenant?.slug ?? ''}&token=${quote.publicToken}`

  const notice = await sendEmail({
    to: quote.customerEmail,
    replyTo: config.notifyEmail || undefined,
    subject: `Quote #${quote.number} from ${tenant?.name ?? 'us'}`,
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

  const now = new Date().toISOString()
  const updated: QuoteRow = {
    ...quote,
    // Sending is what makes a quote real, even if the email bounced - the link
    // still works, and the owner can pass it on by hand.
    status: quote.status === 'draft' ? 'sent' : quote.status,
    sentAt: quote.sentAt ?? now,
    updatedAt: now,
    notifyError: notice.sent ? undefined : notice.error,
  }
  await putQuote(updated)
  await appendContactEvent(tenantId, quote.contactId, {
    moduleId: 'quotes',
    title: `Sent quote #${quote.number} for ${money(quote.totalCents, quote.currency)}`,
    href: `/quotes/${quote.quoteId}`,
  })
  await emitUsage({ tenantId, moduleId: 'quotes', metric: 'quote.sent', quantity: 1 })

  return json(200, { quote: updated, publicUrl: url, emailed: notice.sent, emailError: notice.error })
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
  }
  await putQuotesConfig(config)
  return json(200, { config })
}
