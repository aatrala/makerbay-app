import { newRequest, requestReply } from '@makerbay/email'
import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import {
  appendContactEvent,
  emitUsage,
  findApiKeyByHash,
  getEffectiveEntitlement,
  getTenant,
  getTenantBrand,
  getTenantBySlugOrAlias,
  getUser,
  hashApiKey,
  isPaidWorkspace as isPaidTenant,
  json,
  ownerReplyTo,
  sendEmail,
  ulid,
  upsertContact,
  type CallerContext,
} from '@makerbay/core'
import {
  DEFAULT_REQUESTS_CONFIG,
  DEFAULT_REQUEST_FIELDS,
  countRequestsThisMonth,
  getRequest,
  getRequestsConfig,
  listRequests,
  putRequest,
  putRequestsConfig,
  type RequestKind,
  type RequestRow,
  type RequestStatus,
} from './db'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

const KINDS: RequestKind[] = ['handoff', 'lead', 'feedback', 'missedcall']
const STATUSES: RequestStatus[] = ['new', 'open', 'closed']

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method
  const path = event.rawPath

  try {
    if (path.startsWith('/v1/public/requests')) return await publicRoute(method, path, event)

    const ctx = event.requestContext.authorizer.lambda
    const tenantId = await resolveTenantId(ctx)
    if (!tenantId) return json(401, { error: 'unauthorized' })

    const entitlement = await getEffectiveEntitlement(tenantId, 'requests')
    if (!entitlement.enabled) return json(403, { error: 'module_not_enabled' })

    if (method === 'GET' && path === '/v1/requests') return await index(tenantId, event)
    if (method === 'GET' && path === '/v1/requests/config') {
      return json(200, { config: await getRequestsConfig(tenantId) })
    }
    if (method === 'PUT' && path === '/v1/requests/config') return await updateConfig(tenantId, event)

    const one = path.match(/^\/v1\/requests\/([0-9A-Z]{26})$/)
    if (method === 'GET' && one) return await detail(tenantId, one[1])
    if (method === 'PATCH' && one) return await patch(tenantId, one[1], event)

    const reply = path.match(/^\/v1\/requests\/([0-9A-Z]{26})\/replies$/)
    if (method === 'POST' && reply) return await addReply(tenantId, ctx, reply[1], event)

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('requests error', { path, method, err })
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

// ── Public surface (the assistant widget) ────────────────────────────────

/**
 * Resolves a workspace from a publishable key or a slug. Secret keys are
 * rejected: a public page must never be able to present one, and accepting
 * them here would make a leaked secret key indistinguishable from normal use.
 */
async function resolvePublicTenant(key?: string, slug?: string) {
  if (key) {
    if (!key.startsWith('mb_pk_')) return undefined
    const found = await findApiKeyByHash(hashApiKey(key))
    // Revoking a key deletes its row, so a missing lookup IS the revocation
    // check. Secret keys are refused: a public page must never present one.
    if (!found || found.type !== 'publishable') return undefined
    const tenant = await getTenant(found.tenantId)
    return tenant ? { tenantId: tenant.tenantId, slug: tenant.slug, name: tenant.name } : undefined
  }
  if (slug) {
    const tenant = await getTenantBySlugOrAlias(slug)
    return tenant ? { tenantId: tenant.tenantId, slug: tenant.slug, name: tenant.name } : undefined
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
  const key = String(q.key ?? b.key ?? '') || undefined
  const slug = String(q.slug ?? b.slug ?? '') || undefined

  const resolved = await resolvePublicTenant(key, slug)
  if (!resolved) return json(404, { error: 'not_found' })

  const entitlement = await getEffectiveEntitlement(resolved.tenantId, 'requests')
  if (!entitlement.enabled) return json(404, { error: 'not_found' })

  // What the widget needs to render the form and the handoff offer.
  if (method === 'GET' && path === '/v1/public/requests/config') {
    const config = await getRequestsConfig(resolved.tenantId)
    return json(200, {
      handoffEnabled: config.handoffEnabled,
      handoffPrompt: config.handoffPrompt,
      collectPhone: config.collectPhone,
      fields: config.fields ?? DEFAULT_REQUEST_FIELDS,
    })
  }

  if (method === 'POST' && path === '/v1/public/requests') {
    return await create(resolved.tenantId, entitlement.limits, b, 'widget')
  }

  return json(404, { error: 'not_found' })
}

/**
 * Create a request. Order matters: the contact is written first so a request
 * can never be an orphan nobody finds, then the request, then the timeline
 * entry, then the notification - which is explicitly allowed to fail.
 */
async function create(
  tenantId: string,
  limits: Record<string, number>,
  b: Record<string, unknown>,
  source: RequestRow['source'],
): Promise<APIGatewayProxyResultV2> {
  const message = String(b.message ?? '').trim()
  const email = String(b.email ?? '').trim()
  const phone = String(b.phone ?? '').trim()
  const name = String(b.name ?? '').trim()

  if (message.length < 2) {
    return json(400, { error: 'message_required', message: 'Tell us what you need.' })
  }
  // Without a way to reply, a request is a dead end for both sides.
  if (!email && !phone) {
    return json(400, {
      error: 'contact_required',
      message: 'Leave an email address or a phone number so we can get back to you.',
    })
  }

  const cap = limits.requestsPerMonth ?? 50
  if ((await countRequestsThisMonth(tenantId)) >= cap) {
    return json(429, {
      error: 'limit_exceeded',
      message: `This workspace has reached its ${cap} requests for the month.`,
    })
  }

  const kind: RequestKind = KINDS.includes(b.kind as RequestKind) ? (b.kind as RequestKind) : 'handoff'

  const config = await getRequestsConfig(tenantId)
  const fields = config.fields ?? DEFAULT_REQUEST_FIELDS
  if (fields.phone === 'required' && !phone) {
    return json(400, { error: 'phone_required', message: 'Leave a phone number so we can reach you.' })
  }
  // Only the configured extras are stored - anything else posted is dropped.
  const extra: Record<string, string> = {}
  if (fields.address !== 'off' && b.address) extra.Address = String(b.address).trim().slice(0, 300)
  if (fields.preferredTime !== 'off' && b.preferredTime) {
    extra['Preferred time'] = String(b.preferredTime).trim().slice(0, 120)
  }
  if (fields.custom?.enabled && fields.custom.label && b.custom) {
    extra[fields.custom.label.slice(0, 80)] = String(b.custom).trim().slice(0, 500)
  }

  const contact = await upsertContact(tenantId, { name, email, phone, source: 'requests' })

  const now = new Date().toISOString()
  const requestId = ulid()
  const transcript = Array.isArray(b.transcript)
    ? (b.transcript as Array<Record<string, unknown>>)
        .slice(-6)
        .map((t) => ({ role: String(t.role ?? 'user'), text: String(t.text ?? '').slice(0, 2000) }))
    : undefined

  const row: RequestRow = {
    tenantId,
    requestId,
    kind,
    status: 'new',
    contactId: contact.contactId,
    name: name || undefined,
    email: contact.email,
    phone: contact.phone,
    subject: String(b.subject ?? '').trim().slice(0, 140) || message.slice(0, 60),
    message: message.slice(0, 5000),
    sessionId: b.sessionId ? String(b.sessionId) : undefined,
    transcript,
    extra: Object.keys(extra).length ? extra : undefined,
    source,
    createdAt: now,
    updatedAt: now,
  }

  const tenant = await getTenant(tenantId)
  // Instant lead alerts ride the paid tiers; free workspaces get the daily
  // digest instead (see digest.ts) - a lead never disappears, it just
  // arrives with the morning coffee rather than the moment it lands.
  if (await isPaidTenant(tenantId)) {
    const notifyTo = config.notifyEmail || (await ownerEmail(tenantId))
    const mail = newRequest({
      businessName: tenant?.name ?? 'your business',
      who: name || contact.email || contact.phone || 'Someone',
      kind,
      // The configured extra fields stay with the message. They are often the
      // whole reason the form has more than one box.
      message: [row.message, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)]
        .filter(Boolean)
        .join('\n'),
      contact: contact.email ?? contact.phone ?? undefined,
    })
    const notice = await sendEmail({
      to: notifyTo,
      audience: 'owner' as const,
      ref: { tenantId, moduleId: 'requests', refType: 'request', refId: row.requestId },
      replyTo: contact.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    })
    if (!notice.sent) row.notifyError = notice.error
  }

  await putRequest(row)
  await appendContactEvent(tenantId, contact.contactId, {
    moduleId: 'requests',
    title: kind === 'feedback' ? 'Left feedback' : kind === 'lead' ? 'Asked to be contacted' : 'Asked for a person',
    body: row.message.slice(0, 300),
    href: `/requests/${requestId}`,
  })

  await emitUsage({ tenantId, moduleId: 'requests', metric: 'request.created', quantity: 1 })
  if (!row.notifyError) {
    await emitUsage({ tenantId, moduleId: 'requests', metric: 'notification.sent', quantity: 1 })
  }

  // The customer is told it worked because it did. A mail problem is ours.
  return json(201, { requestId, autoReply: config.autoReply })
}

async function ownerEmail(tenantId: string): Promise<string> {
  const tenant = await getTenant(tenantId)
  return (tenant as { ownerEmail?: string } | undefined)?.ownerEmail ?? ''
}

// ── Authenticated surface ────────────────────────────────────────────────

async function index(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const q = event.queryStringParameters ?? {}
  const status = STATUSES.includes(q.status as RequestStatus) ? (q.status as RequestStatus) : undefined
  const kind = KINDS.includes(q.kind as RequestKind) ? (q.kind as RequestKind) : undefined
  const requests = await listRequests(tenantId, { status, kind })
  const all = status || kind ? await listRequests(tenantId) : requests
  return json(200, {
    requests,
    counts: {
      new: all.filter((r) => r.status === 'new').length,
      open: all.filter((r) => r.status === 'open').length,
      closed: all.filter((r) => r.status === 'closed').length,
    },
  })
}

async function detail(tenantId: string, requestId: string): Promise<APIGatewayProxyResultV2> {
  const request = await getRequest(tenantId, requestId)
  if (!request) return json(404, { error: 'not_found' })
  return json(200, { request })
}

async function patch(tenantId: string, requestId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const request = await getRequest(tenantId, requestId)
  if (!request) return json(404, { error: 'not_found' })

  const status = STATUSES.includes(b.status as RequestStatus) ? (b.status as RequestStatus) : undefined
  if (!status) return json(400, { error: 'unknown_status' })

  const now = new Date().toISOString()
  const updated: RequestRow = {
    ...request,
    status,
    updatedAt: now,
    closedAt: status === 'closed' ? now : undefined,
  }
  await putRequest(updated)
  if (status === 'closed' && request.status !== 'closed') {
    await appendContactEvent(tenantId, request.contactId, {
      moduleId: 'requests',
      title: 'Request closed',
      href: `/requests/${requestId}`,
    })
  }
  return json(200, { request: updated })
}

/** Reply to the customer. Emails them when we have an address. */
async function addReply(
  tenantId: string,
  ctx: CallerContext,
  requestId: string,
  event: Event,
): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const text = String(b.text ?? '').trim()
  if (text.length < 2) return json(400, { error: 'text_required' })

  const request = await getRequest(tenantId, requestId)
  if (!request) return json(404, { error: 'not_found' })

  const brand = await getTenantBrand(tenantId)
  const replyTo = await ownerReplyTo(tenantId)
  const replyMail = requestReply({
    brand,
    contact: { email: replyTo || undefined },
    subject: request.subject,
    body: text,
  })
  const notice = request.email
    ? await sendEmail({
        to: request.email,
        audience: 'customer' as const,
        ref: { tenantId, moduleId: 'requests', refType: 'request', refId: request.requestId },
        fromName: brand.name,
        replyTo,
        subject: replyMail.subject,
        text: replyMail.text,
        html: replyMail.html,
      })
    : { sent: false, error: 'no_recipient' as const }

  const now = new Date().toISOString()
  const updated: RequestRow = {
    ...request,
    // A replied-to request is being handled, so it stops being new.
    status: request.status === 'new' ? 'open' : request.status,
    replies: [
      ...(request.replies ?? []),
      { at: now, byUserId: ctx.userId, text: text.slice(0, 5000), emailed: notice.sent, emailError: notice.error },
    ],
    updatedAt: now,
  }
  await putRequest(updated)
  await appendContactEvent(tenantId, request.contactId, {
    moduleId: 'requests',
    title: notice.sent ? 'You replied' : 'You replied (email not sent)',
    body: text.slice(0, 300),
    href: `/requests/${requestId}`,
  })
  if (notice.sent) {
    await emitUsage({ tenantId, moduleId: 'requests', metric: 'notification.sent', quantity: 1 })
  }
  return json(201, { request: updated, emailed: notice.sent, emailError: notice.error })
}

async function updateConfig(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const existing = await getRequestsConfig(tenantId)
  const config = {
    tenantId,
    notifyEmail: String(b.notifyEmail ?? '').trim().slice(0, 200),
    handoffEnabled: b.handoffEnabled !== false,
    handoffPrompt: String(b.handoffPrompt ?? DEFAULT_REQUESTS_CONFIG.handoffPrompt).slice(0, 300),
    collectPhone: b.collectPhone === true,
    autoReply: String(b.autoReply ?? DEFAULT_REQUESTS_CONFIG.autoReply).slice(0, 300),
    fields: existing.fields,
  }

  // Customising the form beyond the defaults is Trade (issue 50).
  if (b.fields !== undefined) {
    const f = (b.fields ?? {}) as Record<string, unknown>
    const wanted = {
      phone: ['optional', 'required', 'off'].includes(String(f.phone)) ? String(f.phone) : 'optional',
      address: ['optional', 'off'].includes(String(f.address)) ? String(f.address) : 'off',
      preferredTime: ['optional', 'off'].includes(String(f.preferredTime)) ? String(f.preferredTime) : 'off',
      ...(f.custom && typeof f.custom === 'object'
        ? {
            custom: {
              label: String((f.custom as Record<string, unknown>).label ?? '').trim().slice(0, 80),
              enabled: (f.custom as Record<string, unknown>).enabled === true,
            },
          }
        : {}),
    }
    const isDefault =
      wanted.phone === DEFAULT_REQUEST_FIELDS.phone &&
      wanted.address === DEFAULT_REQUEST_FIELDS.address &&
      wanted.preferredTime === DEFAULT_REQUEST_FIELDS.preferredTime &&
      !(wanted as { custom?: { enabled: boolean } }).custom?.enabled
    if (!isDefault && !(await isPaidTenant(tenantId))) {
      return json(402, {
        error: 'plan_required',
        message: 'Choosing what the form asks for comes with the Trade plan.',
      })
    }
    config.fields = wanted as typeof existing.fields
  }

  await putRequestsConfig(config)
  return json(200, { config })
}
