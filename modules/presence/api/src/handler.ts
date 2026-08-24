import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  getEffectiveEntitlement,
  getTenant,
  getTenantBySlug,
  getUser,
  type CallerContext,
} from '@makerbay/core'
import {
  DEFAULT_PRESENCE,
  activeServices,
  assistantView,
  bookingHours,
  getPresenceConfig,
  putPresenceConfig,
  type PresenceConfigRow,
} from './db'
import { indexDirective, isComplete, renderNotFound, renderPage } from './render'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

const s3 = new S3Client({})
const PHOTO_BUCKET = () => process.env.PHOTO_BUCKET!

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

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
    if (method === 'PUT' && path === '/v1/presence/config') return await writeConfig(tenantId, event)
    if (method === 'POST' && path === '/v1/presence/photo') return await photoUpload(tenantId, event)
    if (method === 'POST' && path === '/v1/presence/photo/confirm') return await photoConfirm(tenantId, event)

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
  const slug = String(event.queryStringParameters?.slug ?? '').trim()
  if (!slug) return html(404, renderNotFound())

  const tenant = await getTenantBySlug(slug)
  if (!tenant) return html(404, renderNotFound())

  const config = await getPresenceConfig(tenant.tenantId)
  // Unpublished means 404, not a placeholder: a half-finished page indexed by
  // Google is a liability the owner cannot easily undo (spec §7).
  if (!config.published) return html(404, renderNotFound())

  const [services, hours, assistant, assistantEnt, bookingEnt] = await Promise.all([
    activeServices(tenant.tenantId),
    bookingHours(tenant.tenantId),
    assistantView(tenant.tenantId),
    getEffectiveEntitlement(tenant.tenantId, 'assistant'),
    getEffectiveEntitlement(tenant.tenantId, 'booking'),
  ])

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
    now: new Date(),
  })
  return html(200, page)
}

// ── Owner routes ─────────────────────────────────────────────────────────

async function readConfig(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const [config, services, tenant] = await Promise.all([
    getPresenceConfig(tenantId),
    activeServices(tenantId),
    getTenant(tenantId),
  ])
  const complete = isComplete({ config, services })
  return json(200, {
    config,
    pageUrl: `https://makerbay.app/p/${tenant?.slug ?? ''}`,
    // The dashboard explains indexing state rather than leaving it a mystery.
    indexing: {
      directive: indexDirective({ config, services }),
      complete,
      missing: [
        config.intro.trim().length < 40 ? 'an intro of a few sentences' : null,
        !config.photoKey ? 'a photo' : null,
        !services.some((s) => s.priceCents != null && s.priceCents > 0) ? 'at least one priced service' : null,
      ].filter(Boolean),
      ownSite: Boolean(config.websiteUrl?.trim()),
    },
  })
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
    published: b.published === undefined ? existing.published : b.published === true,
    websiteUrl: websiteUrl || undefined,
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
