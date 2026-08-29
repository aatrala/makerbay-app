import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import {
  ddb,
  getEffectiveEntitlement,
  getSlugAlias,
  getTenant,
  getProspectPreview,
  getTenantBySlug,
  getUser,
  type CallerContext,
  json,
  requireScope,
} from '@makerbay/core'
import {
  DEFAULT_PRESENCE,
  activeServices,
  assistantView,
  bookingHours,
  findByCustomDomain,
  getPresenceConfig,
  publishedReviews,
  putPresenceConfig,
  type PresenceConfigRow,
} from './db'
import { copyDraft } from './copy'
import { deleteDomain, getDomain, putDomain } from './domain'
import { listVersions, readPage, restoreVersion, writePage } from './page'
import { SUB_PAGES, indexDirective, isComplete, renderNotFound, renderPage, type SubPage } from './render'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

const s3 = new S3Client({})
const PHOTO_BUCKET = () => process.env.PHOTO_BUCKET!

const html = (statusCode: number, body: string): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    // Cached at CloudFront; edits appear within one cache period (spec §9).
    'cache-control': 'public, max-age=60, s-maxage=300',
    'x-content-type-options': 'nosniff',
  },
  body,
})

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method
  const path = event.rawPath

  try {
    if (path.startsWith('/v1/public/presence')) return await publicRoute(method, event)

    const ctx = event.requestContext.authorizer.lambda
    const tenantId = await resolveTenantId(ctx)
    if (!tenantId) return json(401, { error: 'unauthorized' })
    // Presence is free and always on; no entitlement gate on the owner routes.

    if (method === 'GET' && path === '/v1/presence/config') return await readConfig(tenantId)
    if (method === 'PUT' && path === '/v1/presence/config') {
      const denied = requireScope(ctx, 'presence:config:write')
      if (denied) return denied
      return await writeConfig(tenantId, event)
    }
    if (method === 'GET' && path === '/v1/presence/page') return await readPage(tenantId)
    if (method === 'PUT' && path === '/v1/presence/page') {
      const denied = requireScope(ctx, 'presence:page:write')
      if (denied) return denied
      return await writePage(tenantId, body(event), actorOf(event))
    }
    if (method === 'POST' && path === '/v1/presence/preview') return await previewDraft(tenantId, body(event))
    if (method === 'POST' && path === '/v1/presence/copy-draft') return await copyDraft(tenantId, body(event))
    if (method === 'GET' && path === '/v1/presence/versions') return await listVersions(tenantId)
    if (method === 'POST' && path === '/v1/presence/versions/restore') {
      return await restoreVersion(tenantId, body(event), actorOf(event))
    }
    if (method === 'POST' && path === '/v1/presence/photo') {
      const denied = requireScope(ctx, 'presence:photo:write')
      if (denied) return denied
      return await photoUpload(tenantId, event)
    }
    if (method === 'POST' && path === '/v1/presence/photo/confirm') {
      const denied = requireScope(ctx, 'presence:photo:write')
      if (denied) return denied
      return await photoConfirm(tenantId, event)
    }

    // Presence Pro: the page on the tenant's own domain.
    if (method === 'GET' && path === '/v1/presence/domain') return await getDomain(tenantId)
    if (method === 'PUT' && path === '/v1/presence/domain') return await putDomain(tenantId, body(event))
    if (method === 'DELETE' && path === '/v1/presence/domain') return await deleteDomain(tenantId)

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('presence error', { path, method, err })
    return json(500, { error: 'internal_error' })
  }
}

async function resolveTenantId(ctx: CallerContext): Promise<string> {
  if (ctx.keyId) return ctx.tenantId
  if (!ctx.userId) return ''
  return (await getUser(ctx.userId))?.tenantId ?? ''
}

// ── Public page ──────────────────────────────────────────────────────────

async function publicRoute(method: string, event: Event): Promise<APIGatewayProxyResultV2> {
  if (method !== 'GET') return json(404, { error: 'not_found' })

  // Sub-page segment (grow/storefront styles): /p/{slug}/faq, or /faq on a
  // custom domain. Anything unrecognised is a plain 404.
  const rawSub = String(event.queryStringParameters?.sub ?? '').trim().toLowerCase()
  const sub = SUB_PAGES.includes(rawSub as SubPage) ? (rawSub as SubPage) : undefined
  if (rawSub && !sub) return html(404, renderNotFound())

  /*
   * A page for somebody who does not have an account yet (issue 145).
   *
   * The homepage promises "Show us your business. Get a page back." It was
   * handing back a table of extracted fields, which is a spreadsheet, not a
   * page. This renders the real thing from the same function that serves
   * every live page, so what a stranger sees is what they would get.
   *
   * It lives on this route rather than a new one because a new route is a
   * CloudFormation resource and the stack is at 492 of a hard 500. The draft
   * is read through packages/core, which is where cross-module data access
   * belongs.
   *
   * Always noindex: this is a proposal about somebody else's business, built
   * from their public website, and it must never appear in a search result.
   */
  const previewToken = String(event.queryStringParameters?.preview ?? '').trim()
  if (previewToken) {
    const draft = await getProspectPreview(previewToken)
    if (!draft) return html(404, renderNotFound())
    const name = draft.businessName?.trim() || 'Your business'
    const page = renderPage({
      config: {
        tenantId: 'preview',
        ...DEFAULT_PRESENCE,
        ...draft.proposed,
        // Never indexed, and never treated as live.
        published: false,
      } as never,
      businessName: name,
      slug: 'preview',
      services: [],
      assistant: { greeting: '', tone: 'friendly' } as never,
      hasKnowledge: false,
      // Nothing behind it yet, so neither control would work.
      bookingEnabled: false,
      now: new Date(),
    })
    return html(200, page)
  }

  // A custom-domain distribution identifies the tenant by host, not slug.
  const domain = String(event.queryStringParameters?.domain ?? '').trim().toLowerCase()
  if (domain) {
    const config = await findByCustomDomain(domain)
    if (!config || !config.published || config.domainStatus === 'pending_validation') {
      return html(404, renderNotFound())
    }
    const tenant = await getTenant(config.tenantId)
    if (!tenant) return html(404, renderNotFound())
    if (sub && (config.pageStyle ?? 'simple') === 'simple') {
      return redirect(`https://${domain}/`)
    }
    return await renderFor(tenant, config, `https://${domain}/`, sub)
  }

  const slug = String(event.queryStringParameters?.slug ?? '').trim()
  if (!slug) return html(404, renderNotFound())

  let tenant = await getTenantBySlug(slug)
  if (!tenant) {
    // An extra address 301s to the primary - redirect, never serve, so two
    // URLs never carry the same page and split its search standing.
    const alias = await getSlugAlias(slug.toLowerCase())
    if (alias) {
      tenant = await getTenantBySlug((await getTenant(alias.tenantId))?.slug ?? '')
      if (tenant) {
        return {
          statusCode: 301,
          headers: {
            location: `https://makerbay.app/p/${tenant.slug}`,
            'cache-control': 'public, max-age=300',
          },
          body: '',
        }
      }
    }
    return html(404, renderNotFound())
  }

  const config = await getPresenceConfig(tenant.tenantId)
  // Unpublished means 404, not a placeholder: a half-finished page indexed by
  // Google is a liability the owner cannot easily undo (spec §7).
  if (!config.published) return html(404, renderNotFound())

  // On the simple style, sub-page URLs go home rather than 404 - a link
  // shared while the page was on Grow keeps working after a downgrade.
  if (sub && (config.pageStyle ?? 'simple') === 'simple') {
    return redirect(`https://makerbay.app/p/${tenant.slug}`)
  }

  // An active custom domain is the canonical home; the free page points at it.
  const canonical = config.domainStatus === 'active' && config.customDomain
    ? `https://${config.customDomain}/`
    : undefined
  return await renderFor(tenant, config, canonical, sub)
}

/**
 * Unsaved-changes preview (issue 51 follow-up): render the page as it WOULD
 * look with the posted draft laid over the saved config. Nothing is stored;
 * the renderer escapes everything, so a draft can't smuggle markup.
 */
async function previewDraft(tenantId: string, b: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const tenant = await getTenant(tenantId)
  if (!tenant) return json(404, { error: 'no_tenant' })
  const saved = await getPresenceConfig(tenantId)

  const draft: PresenceConfigRow = {
    ...saved,
    headline: b.headline === undefined ? saved.headline : String(b.headline).slice(0, 120),
    intro: b.intro === undefined ? saved.intro : String(b.intro).slice(0, 2000),
    serviceAreas: Array.isArray(b.serviceAreas)
      ? (b.serviceAreas as unknown[]).map(String).map((x) => x.trim()).filter(Boolean).slice(0, 20)
      : saved.serviceAreas,
    phone: b.phone === undefined ? saved.phone : String(b.phone).slice(0, 30),
    email: b.email === undefined ? saved.email : String(b.email).slice(0, 200),
    accentColor: b.accentColor !== undefined && /^#[0-9a-fA-F]{6}$/.test(String(b.accentColor))
      ? String(b.accentColor)
      : saved.accentColor,
    themeStyle: (['fresh', 'warm', 'bold'] as const).find((t) => t === b.themeStyle) ?? saved.themeStyle,
    showBooking: b.showBooking === undefined ? saved.showBooking : b.showBooking === true,
    showAssistant: b.showAssistant === undefined ? saved.showAssistant : b.showAssistant === true,
    showQr: b.showQr === undefined ? saved.showQr : b.showQr === true,
    published: true,
  }
  const draftName = b.businessName !== undefined && String(b.businessName).trim().length >= 2
    ? String(b.businessName).trim().slice(0, 80)
    : tenant.name
  return await renderFor({ ...tenant, name: draftName }, draft, undefined)
}

const redirect = (location: string): APIGatewayProxyResultV2 => ({
  statusCode: 301,
  headers: { location, 'cache-control': 'public, max-age=300' },
  body: '',
})

async function renderFor(
  tenant: { tenantId: string; name: string; slug: string },
  config: PresenceConfigRow,
  canonicalUrl?: string,
  sub?: SubPage,
): Promise<APIGatewayProxyResultV2> {
  const [services, hours, assistant, assistantEnt, bookingEnt, reviewsEnt, currency] = await Promise.all([
    activeServices(tenant.tenantId),
    bookingHours(tenant.tenantId),
    assistantView(tenant.tenantId),
    getEffectiveEntitlement(tenant.tenantId, 'assistant'),
    getEffectiveEntitlement(tenant.tenantId, 'booking'),
    getEffectiveEntitlement(tenant.tenantId, 'reviews'),
    // The workspace currency lives in Quotes settings; prices on the page
    // must match what a quote would say.
    ddb.send(new GetCommand({ TableName: process.env.TABLE_QUOTESCONFIG!, Key: { tenantId: tenant.tenantId } }))
      .then((r) => (r.Item?.currency ? String(r.Item.currency) : undefined))
      .catch(() => undefined),
  ])
  const reviews = reviewsEnt.enabled ? await publishedReviews(tenant.tenantId) : undefined

  // The scan-to-book QR (issue 60): rendered server-side as a data URI so
  // the page stays JavaScript-free. Points at the booking flow when it
  // exists, else the chat - the action, not the page itself.
  let qr: { dataUri: string; label: string } | undefined
  if (config.showQr) {
    try {
      const { toDataURL } = await import('qrcode')
      const target = bookingEnt.enabled && services.length
        ? { url: `https://chat.makerbay.app/booking?slug=${encodeURIComponent(tenant.slug)}`, label: 'Scan to book on your phone' }
        : { url: canonicalUrl ?? `https://makerbay.app/p/${tenant.slug}`, label: 'Scan to open on your phone' }
      qr = { dataUri: await toDataURL(target.url, { width: 240, margin: 1 }), label: target.label }
    } catch (err) {
      console.warn('qr generation failed', { tenantId: tenant.tenantId, err: String(err) })
    }
  }

  const page = renderPage({
    config,
    businessName: tenant.name,
    slug: tenant.slug,
    services,
    hours,
    assistant,
    // "Has knowledge" would need the sources table; the assistant entitlement
    // plus a non-default greeting is the cheap proxy. The block only links to
    // the hosted chat, which itself degrades gracefully when knowledge is thin.
    hasKnowledge: assistantEnt.enabled,
    bookingEnabled: bookingEnt.enabled,
    reviews,
    currency,
    canonicalUrl,
    now: new Date(),
    sub,
    qr,
  })
  return html(200, page)
}

// ── Owner routes ─────────────────────────────────────────────────────────

async function readConfig(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const [config, services, tenant, hours, bookingEnt, reviewsEnt, reviews, visibilityCfg] = await Promise.all([
    getPresenceConfig(tenantId),
    activeServices(tenantId),
    getTenant(tenantId),
    bookingHours(tenantId),
    getEffectiveEntitlement(tenantId, 'booking'),
    getEffectiveEntitlement(tenantId, 'reviews'),
    publishedReviews(tenantId),
    // The review link lives under Get found; the checklist points there.
    ddb.send(new GetCommand({ TableName: process.env.TABLE_VISIBILITYCONFIG!, Key: { tenantId } }))
      .then((r) => r.Item)
      .catch(() => undefined),
  ])
  const complete = isComplete({ config, services })
  const hasHours = Boolean(hours && Object.values(hours.hours).some((w) => w?.length))
  const priced = services.some((s) => s.priceCents != null && s.priceCents > 0)

  // The full path from "page exists" to "page earns work", each step
  // deep-linked to where it is done. done/todo/soon - soon items are things
  // the platform itself has not shipped, said plainly rather than hidden.
  const checklist = [
    { key: 'intro', label: 'Write an intro of a few sentences', done: config.intro.trim().length >= 40, to: '/page' },
    { key: 'photo', label: 'Add a photo', done: Boolean(config.photoKey), to: '/page' },
    { key: 'service', label: 'Add at least one priced service', done: priced, to: '/booking/services' },
    { key: 'hours', label: 'Set your opening hours', done: hasHours, to: '/booking/hours' },
    { key: 'booking', label: 'Let customers book from the page', done: bookingEnt.enabled && config.showBooking && services.length > 0, to: '/booking/services' },
    { key: 'reviews', label: 'Show customer reviews on the page', done: Boolean(reviewsEnt.enabled && reviews && reviews.count > 0), to: '/reviews' },
    { key: 'reviewLink', label: 'Add your Google review link (under Get found)', done: Boolean(visibilityCfg?.reviewLink), to: '/visibility' },
    { key: 'payments', label: 'Take payments on the page', done: false, soon: true, to: '' },
  ]

  return json(200, {
    config,
    pageUrl: `https://makerbay.app/p/${tenant?.slug ?? ''}`,
    checklist,
    // The dashboard explains indexing state rather than leaving it a mystery.
    indexing: {
      directive: indexDirective({ config, services }),
      complete,
      missing: [
        config.intro.trim().length < 40 ? 'an intro of a few sentences' : null,
        !config.photoKey ? 'a photo' : null,
        !priced ? 'at least one priced service' : null,
      ].filter(Boolean),
      ownSite: Boolean(config.websiteUrl?.trim()),
    },
  })
}

const actorOf = (event: Event): { userId?: string; email?: string } => {
  const ctx = event.requestContext.authorizer.lambda
  return { userId: ctx.userId, email: ctx.email }
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

async function writeConfig(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const existing = await getPresenceConfig(tenantId)

  const websiteUrl = b.websiteUrl === undefined ? existing.websiteUrl : String(b.websiteUrl).trim()
  if (websiteUrl && !/^https?:\/\/[^\s]+\.[^\s]+/.test(websiteUrl)) {
    return json(400, { error: 'invalid_url', message: 'The website address needs to be a full https:// link.' })
  }

  const config: PresenceConfigRow = {
    ...existing,
    tenantId,
    headline: String(b.headline ?? existing.headline).slice(0, 120),
    intro: String(b.intro ?? existing.intro).slice(0, 2000),
    serviceAreas: Array.isArray(b.serviceAreas)
      ? (b.serviceAreas as unknown[]).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20)
      : existing.serviceAreas,
    phone: String(b.phone ?? existing.phone).slice(0, 30),
    email: String(b.email ?? existing.email).slice(0, 200),
    showBooking: b.showBooking === undefined ? existing.showBooking : b.showBooking === true,
    showAssistant: b.showAssistant === undefined ? existing.showAssistant : b.showAssistant === true,
    showQr: b.showQr === undefined ? existing.showQr : b.showQr === true,
    published: b.published === undefined ? existing.published : b.published === true,
    websiteUrl: websiteUrl || undefined,
    accentColor: b.accentColor === undefined
      ? existing.accentColor
      : /^#[0-9a-fA-F]{6}$/.test(String(b.accentColor)) ? String(b.accentColor) : undefined,
    themeStyle: b.themeStyle === undefined
      ? existing.themeStyle
      : (['fresh', 'warm', 'bold'] as const).find((t) => t === b.themeStyle),
    updatedAt: new Date().toISOString(),
  }
  await putPresenceConfig(config)
  return readConfig(tenantId)
}

const PHOTO_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** Presigned upload for the one hero image. Served publicly via the embed CDN. */
async function photoUpload(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const contentType = String(b.contentType ?? '')
  const ext = PHOTO_TYPES[contentType]
  if (!ext) {
    return json(400, { error: 'unsupported_type', message: 'Use a JPEG, PNG or WebP image.' })
  }

  // A fixed key per tenant: re-uploading replaces, and the page URL is stable.
  const key = `p/${tenantId}/hero.${ext}`
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: PHOTO_BUCKET(),
      Key: key,
      ContentType: contentType,
      // The CDN caches; a day is fine for a hero image that rarely changes.
      CacheControl: 'public, max-age=86400',
    }),
    { expiresIn: 300 },
  )

  // Nothing is stored yet. A presign is an intention, not a photo - recording
  // the key now would leave the page pointing at a missing image whenever the
  // upload fails, and would count a phantom photo toward completeness.
  return json(200, { uploadUrl, photoKey: key, photoUrl: `https://chat.makerbay.app/${key}` })
}

/** Called after the browser's PUT succeeds. Verified against S3, not trusted. */
async function photoConfirm(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const b = body(event)
  const key = String(b.photoKey ?? '')
  // The key shape is ours; a tenant can only ever confirm their own prefix.
  if (!new RegExp(`^p/${tenantId}/hero\.(jpg|png|webp)$`).test(key)) {
    return json(400, { error: 'bad_key' })
  }
  try {
    await s3.send(new HeadObjectCommand({ Bucket: PHOTO_BUCKET(), Key: key }))
  } catch {
    return json(409, { error: 'upload_missing', message: 'The upload did not finish. Try again.' })
  }
  const existing = await getPresenceConfig(tenantId)
  await putPresenceConfig({ ...existing, tenantId, photoKey: key, updatedAt: new Date().toISOString() })
  return readConfig(tenantId)
}

// Re-exported so the module's own defaults are the single source in tests.
export { DEFAULT_PRESENCE }
