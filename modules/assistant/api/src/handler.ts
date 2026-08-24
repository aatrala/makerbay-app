import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import {
  ddb as ddbRaw,
  emitUsage,
  findApiKeyByHash,
  getEffectiveEntitlement,
  getMonthUsage,
  getTenant,
  getTenantBySlug,
  getUser,
  hashApiKey,
  ulid,
  type CallerContext,
} from '@makerbay/core'
import {
  DEFAULT_CONFIG,
  deleteSource,
  getConfig,
  getSessionMessages,
  getSource,
  listRecentMessages,
  listSources,
  putConfig,
  putMessage,
  putSource,
  setMessageFeedback,
  updateSourceStatus,
  type MessageRow,
  type SourceRow,
  businessFacts,
  businessProfile,
} from './db'
import {
  buildCitations,
  generateAnswer,
  generateHelpMeta,
  getIngestionStatus,
  retrieveChunks,
  startIngestion,
} from './rag'
import {
  renderArticle,
  renderIndex,
  renderNotFound,
  renderRobots,
  renderSitemap,
  sourceIdFromSlug,
} from './help'
import { discoverPages, scrapePage } from './scrape'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

const s3 = new S3Client({})
const BUCKET = () => process.env.KNOWLEDGE_BUCKET!

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method
  const path = event.rawPath

  try {
    // Public widget/hosted-page surface runs without the authorizer, so it
    // must not read authorizer context.
    // The help centre renders HTML, not JSON, so it dispatches before the
    // JSON public routes rather than through them.
    if (method === 'GET' && path.startsWith('/v1/public/assistant/help')) return await helpRoute(event)
    if (path.startsWith('/v1/public/assistant')) return await publicRoute(method, path, event)

    const ctx = event.requestContext.authorizer.lambda
    // Entitlement gate — read fresh, not from the (up to 5 min stale)
    // authorizer cache, because limits depend on it.
    const tenantId = await resolveTenantId(ctx)
    if (!tenantId) return json(404, { error: 'no_tenant' })
    const entitlement = await getEffectiveEntitlement(tenantId, 'assistant')
    if (!entitlement.enabled) return json(403, { error: 'module_not_enabled', moduleId: 'assistant' })

    const isAdminCaller = Boolean(ctx.userId) || ctx.scopes === '*'

    if (method === 'POST' && path === '/v1/assistant/chat')
      return await chat(tenantId, entitlement.limits, event)
    if (method === 'POST' && path === '/v1/assistant/feedback') return await feedback(tenantId, event)

    // Everything below is tenant administration: dashboard users or secret keys.
    if (!isAdminCaller) return json(403, { error: 'insufficient_scope' })

    if (method === 'POST' && path === '/v1/assistant/sources')
      return await createSource(tenantId, entitlement.limits, event)
    if (method === 'GET' && path === '/v1/assistant/sources') return await getSources(tenantId)
    const ingestMatch = path.match(/^\/v1\/assistant\/sources\/([A-Z0-9]+)\/ingest$/)
    if (method === 'POST' && ingestMatch) return await ingestSource(tenantId, ingestMatch[1])
    if (method === 'POST' && path === '/v1/assistant/sources/discover') return await discover(event)
    const previewMatch = path.match(/^\/v1\/assistant\/sources\/([A-Z0-9]+)\/preview$/)
    if (method === 'GET' && previewMatch) return await preview(tenantId, previewMatch[1])
    const refreshMatch = path.match(/^\/v1\/assistant\/sources\/([A-Z0-9]+)\/refresh$/)
    if (method === 'POST' && refreshMatch) return await refresh(tenantId, refreshMatch[1])
    const deleteMatch = path.match(/^\/v1\/assistant\/sources\/([A-Z0-9]+)$/)
    if (method === 'DELETE' && deleteMatch) return await removeSource(tenantId, deleteMatch[1])

    if (method === 'GET' && path === '/v1/assistant/config')
      return json(200, { config: await getConfig(tenantId) })
    if (method === 'PUT' && path === '/v1/assistant/config') return await updateConfig(tenantId, event)

    const publishMatch = path.match(/^\/v1\/assistant\/sources\/([A-Z0-9]+)\/publish$/)
    if (method === 'POST' && publishMatch) return await setPublished(tenantId, publishMatch[1], event)

    if (method === 'GET' && path === '/v1/assistant/conversations')
      return await conversations(tenantId, event)
    if (method === 'GET' && path === '/v1/assistant/insights') return await insights(tenantId)

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('assistant-api error', { path, method, err })
    return json(500, { error: 'internal_error' })
  }
}

async function resolveTenantId(ctx: CallerContext): Promise<string> {
  if (ctx.keyId) return ctx.tenantId
  if (!ctx.userId) return ''
  return (await getUser(ctx.userId))?.tenantId ?? ''
}

// ── Public surface (widget + hosted page) ────────────────────────────────

/**
 * Identify a tenant from a publishable key or a workspace slug. Secret keys
 * are rejected here: a public page must never be able to present one and
 * gain more than chat access.
 */
async function resolvePublicTenant(
  key?: string,
  slug?: string,
): Promise<{ tenantId: string; slug: string } | undefined> {
  if (key) {
    if (!key.startsWith('mb_pk_')) return undefined
    const row = await findApiKeyByHash(hashApiKey(key))
    // A publishable key authorises the workspace's *public surface*, not one
    // frozen capability. Keys are pasted into customers' own websites and can
    // never be re-issued in practice, so what they may reach has to follow the
    // workspace's current entitlements rather than the scope list captured at
    // creation time. Secret-key rejection below is what actually matters here.
    if (!row || row.type !== 'publishable') return undefined
    const tenant = await getTenant(row.tenantId)
    return { tenantId: row.tenantId, slug: tenant?.slug ?? '' }
  }
  if (slug) {
    const tenant = await getTenantBySlug(slug)
    if (!tenant || tenant.status !== 'active') return undefined
    return { tenantId: tenant.tenantId, slug: tenant.slug }
  }
  return undefined
}

/**
 * Public help centre, served at help.makerbay.app/{slug}. CloudFront rewrites
 * the friendly path into this route, so `slug` and `article` arrive as query
 * parameters. Errors render as HTML pages, never JSON: a crawler that gets a
 * JSON body for an HTML request indexes nonsense.
 */
async function helpRoute(event: Event): Promise<APIGatewayProxyResultV2> {
  const q = event.queryStringParameters ?? {}
  const slug = String(q.slug ?? '').trim()
  const article = String(q.article ?? '').trim()
  const wantsSitemap = q.sitemap === '1'
  const wantsRobots = q.robots === '1'

  if (wantsRobots && !slug) return renderRobots()
  if (!slug) return renderNotFound()

  const tenant = await getTenantBySlug(slug)
  if (!tenant) return renderNotFound()

  const entitlement = await getEffectiveEntitlement(tenant.tenantId, 'assistant')
  if (!entitlement.enabled) return renderNotFound()

  const config = { ...DEFAULT_CONFIG, ...(await getConfig(tenant.tenantId)) }
  if (!config.helpEnabled) return renderNotFound()
  // The centre is the BUSINESS's help, not the assistant's - default the
  // title from the business name, not the bot's display name.
  if (!config.helpTitle?.trim()) config.helpTitle = `${tenant.name} help centre`
  // Same rule as the chat surface: the page's accent colour wins, so the
  // help centre, the page and the chat read as one business.
  const presence = await ddbRaw.send(
    new GetCommand({ TableName: process.env.TABLE_PRESENCECONFIG!, Key: { tenantId: tenant.tenantId } }),
  ).catch(() => undefined)
  const accent = String(presence?.Item?.accentColor ?? '')
  if (/^#[0-9a-fA-F]{6}$/.test(accent)) config.brandColor = accent

  const published = (await listSources(tenant.tenantId))
    .filter((s) => s.published && s.status === 'ready')
    .sort((a, b) => a.name.localeCompare(b.name))

  if (wantsRobots) return renderRobots(slug)
  if (wantsSitemap) return renderSitemap(slug, published)

  if (article) {
    const sourceId = sourceIdFromSlug(article)
    const source = published.find((s) => s.sourceId === sourceId)
    if (!source) return renderNotFound()
    const text = await sourceText(source)
    if (!text) return renderNotFound()
    return renderArticle(config, slug, source, text)
  }

  // Index: one short excerpt each, read in parallel and capped so a large
  // help centre cannot blow the Lambda timeout.
  const excerpts: Record<string, string> = {}
  await Promise.all(
    published.slice(0, 40).map(async (s) => {
      excerpts[s.sourceId] = (await sourceText(s)).replace(/\s+/g, ' ').slice(0, 200)
    }),
  )
  return renderIndex(config, slug, published, excerpts)
}

/** Extracted text for a source, or '' when it cannot be read. */
async function sourceText(source: SourceRow): Promise<string> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET(), Key: source.s3Key }))
    const full = (await obj.Body?.transformToString()) ?? ''
    // Scraped pages are stored with a small provenance header; drop it.
    const stripped = full.replace(/^(Source|Title|Fetched):.*\n/gm, '').trim()
    return stripped.slice(0, 60000)
  } catch {
    return ''
  }
}

async function publicRoute(
  method: string,
  path: string,
  event: Event,
): Promise<APIGatewayProxyResultV2> {
  const body = method === 'POST' ? JSON.parse(event.body ?? '{}') : {}
  const key = String(event.queryStringParameters?.key ?? body.key ?? '') || undefined
  const slug = String(event.queryStringParameters?.slug ?? body.slug ?? '') || undefined

  const resolved = await resolvePublicTenant(key, slug)
  if (!resolved) return json(404, { error: 'assistant_not_found' })

  const entitlement = await getEffectiveEntitlement(resolved.tenantId, 'assistant')
  if (!entitlement.enabled) return json(404, { error: 'assistant_not_found' })

  // Display config only — instructions are the tenant's private prompt.
  if (method === 'GET' && path === '/v1/public/assistant/config') {
    const config = await getConfig(resolved.tenantId)
    // The page's accent colour wins when set, so the chat surface and the
    // business page read as one thing, not two products.
    const presence = await ddbRaw.send(
      new GetCommand({ TableName: process.env.TABLE_PRESENCECONFIG!, Key: { tenantId: resolved.tenantId } }),
    ).catch(() => undefined)
    const accent = String(presence?.Item?.accentColor ?? '')
    const [bookingEnt, tenantRow] = await Promise.all([
      getEffectiveEntitlement(resolved.tenantId, 'booking'),
      getTenant(resolved.tenantId),
    ])
    return json(200, {
      assistant: {
        name: config.name,
        greeting: config.greeting,
        brandColor: /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : config.brandColor,
        slug: resolved.slug,
        // Lets the chat surface offer a real Book a time action instead of
        // the assistant describing one in prose.
        bookingEnabled: bookingEnt.enabled,
      },
      // Structured facts the chat renders as instant cards - a visitor never
      // pays a conversation turn for a price or an opening time.
      business: await businessProfile(resolved.tenantId, tenantRow?.name ?? config.name),
    })
  }

  if (method === 'POST' && path === '/v1/public/assistant/chat')
    return await chat(resolved.tenantId, entitlement.limits, event)

  // End-user thumbs from the widget and hosted page — the signal the SMB
  // acts on in their inbox.
  if (method === 'POST' && path === '/v1/public/assistant/feedback')
    return await feedback(resolved.tenantId, event)

  return json(404, { error: 'not_found' })
}

// ── Chat ─────────────────────────────────────────────────────────────────

async function chat(
  tenantId: string,
  limits: Record<string, number>,
  event: Event,
): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const message = String(body.message ?? '').trim()
  if (!message) return json(400, { error: 'message_required' })
  const sessionId = /^[A-Z0-9]{10,32}$/.test(String(body.sessionId ?? '')) ? body.sessionId : ulid()

  const monthUsage = await getMonthUsage(tenantId, new Date().toISOString().slice(0, 7))
  const used = monthUsage['assistant.message'] ?? 0
  const limit = limits.messagesPerMonth ?? 200
  if (used >= limit) return json(429, { error: 'limit_exceeded', limit, used })

  const config = await getConfig(tenantId)
  const history = await getSessionMessages(tenantId, sessionId, 10)
  const [chunks, tenantRow] = await Promise.all([
    retrieveChunks(tenantId, message),
    getTenant(tenantId),
  ])
  const facts = await businessFacts(tenantId, tenantRow?.name ?? '')

  let answer: string
  let fallback = false
  let tokens = 0
  if (chunks.length === 0 && !facts) {
    answer = config.fallbackMessage
    fallback = true
  } else {
    const generated = await generateAnswer(config, chunks, history, message, facts)
    answer = generated.text
    fallback = generated.fallback
    tokens = generated.inputTokens + generated.outputTokens
  }

  const citations = fallback ? [] : buildCitations(chunks)

  const now = new Date().toISOString()
  const pk = `${tenantId}#${sessionId}`
  const assistantSk = `${now}#${ulid()}`
  const common = { pk, tenantId, sessionId }
  await putMessage({ ...common, sk: `${now}#0${ulid()}`, role: 'user', text: message })
  await putMessage({ ...common, sk: assistantSk, role: 'assistant', text: answer, citations, fallback })

  await emitUsage({ tenantId, moduleId: 'assistant', metric: 'message', quantity: 1 })
  if (tokens > 0) await emitUsage({ tenantId, moduleId: 'assistant', metric: 'tokens', quantity: tokens })

  return json(200, { sessionId, messageId: assistantSk, answer, citations, fallback })
}

async function feedback(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const { sessionId, messageId, feedback: fb } = body
  if (!sessionId || !messageId || !['up', 'down'].includes(fb))
    return json(400, { error: 'sessionId_messageId_feedback_required' })
  try {
    await setMessageFeedback(tenantId, String(sessionId), String(messageId), fb)
  } catch {
    return json(404, { error: 'message_not_found' })
  }
  return json(200, { ok: true })
}

// ── Sources ──────────────────────────────────────────────────────────────

function objectKey(tenantId: string, sourceId: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'document'
  return `knowledge/${tenantId}/${sourceId}/${safe}`
}

// Sidecar metadata is what makes multi-tenant retrieval filtering work —
// every document carries its tenantId into the vector store.
async function writeMetadataSidecar(
  key: string,
  tenantId: string,
  sourceId: string,
  name: string,
  sourceUrl?: string,
) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: `${key}.metadata.json`,
      Body: JSON.stringify({
        metadataAttributes: { tenantId, sourceId, sourceName: name, ...(sourceUrl ? { sourceUrl } : {}) },
      }),
      ContentType: 'application/json',
    }),
  )
}

async function createSource(
  tenantId: string,
  limits: Record<string, number>,
  event: Event,
): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const type: 'file' | 'text' | 'url' =
    body.type === 'file' ? 'file' : body.type === 'url' ? 'url' : 'text'
  const name = String(body.name ?? body.url ?? '').trim().slice(0, 120)
  if (!name) return json(400, { error: 'name_required' })

  const existing = await listSources(tenantId)
  if (existing.length >= (limits.sources ?? 20)) return json(429, { error: 'source_limit_reached' })

  const sourceId = ulid()
  const key = objectKey(tenantId, sourceId, name)
  const now = new Date().toISOString()

  if (type === 'url') {
    // Fetch failures are the user's problem to fix (bad URL, blocked by
    // robots, unreachable host), so return the reason rather than a 500.
    let page
    try {
      page = await scrapePage(String(body.url ?? ''))
    } catch (err) {
      return json(400, {
        error: 'fetch_failed',
        message: err instanceof Error ? err.message : 'Could not fetch that page.',
      })
    }
    // A page that yields almost nothing is usually JavaScript-rendered.
    // Storing it would quietly pollute the knowledge base with noise the
    // assistant then cites, so refuse by default and explain — but let the
    // owner insist, because some legitimate pages really are short.
    if (page.charCount < 200 && body.allowShort !== true) {
      return json(422, {
        error: page.charCount === 0 ? 'no_text_extracted' : 'too_little_text',
        message:
          page.warning === 'looks_javascript_rendered'
            ? `Only ${page.charCount} characters of text came back, which usually means the page builds its content with JavaScript. Try a sitemap page, the site's /llms.txt, or paste the text instead.`
            : `Only ${page.charCount} characters of text came back from that page.`,
        charCount: page.charCount,
        warning: page.warning,
      })
    }
    const stored = `Source: ${page.url}

${page.text}`
    await s3.send(new PutObjectCommand({ Bucket: BUCKET(), Key: key, Body: stored, ContentType: 'text/plain' }))
    await writeMetadataSidecar(key, tenantId, sourceId, page.title || name, page.url)
    const row: SourceRow = {
      tenantId, sourceId, name: page.title || name, type: 'url', s3Key: key,
      status: 'processing', sizeBytes: stored.length, sourceUrl: page.url,
      fetchedAt: now, charCount: page.charCount, warning: page.warning,
      createdAt: now, updatedAt: now,
    }
    await putSource(row)
    const jobId = await tryStartIngestion()
    if (jobId) await updateSourceStatus(tenantId, sourceId, 'processing', jobId)
    await emitUsage({ tenantId, moduleId: 'assistant', metric: 'ingest.documents', quantity: 1 })
    return json(201, { source: { ...row, ingestionJobId: jobId } })
  }

  if (type === 'text') {
    const text = String(body.text ?? '').trim()
    if (!text) return json(400, { error: 'text_required' })
    if (text.length > 500_000) return json(400, { error: 'text_too_large' })
    await s3.send(
      new PutObjectCommand({ Bucket: BUCKET(), Key: key, Body: text, ContentType: 'text/plain' }),
    )
    await writeMetadataSidecar(key, tenantId, sourceId, name)
    const row: SourceRow = {
      tenantId, sourceId, name, type, s3Key: key,
      status: 'processing', sizeBytes: text.length, createdAt: now, updatedAt: now,
    }
    await putSource(row)
    const jobId = await tryStartIngestion()
    if (jobId) await updateSourceStatus(tenantId, sourceId, 'processing', jobId)
    await emitUsage({ tenantId, moduleId: 'assistant', metric: 'ingest.documents', quantity: 1 })
    return json(201, { source: { ...row, ingestionJobId: jobId } })
  }

  // type === 'file': presigned upload, client calls /ingest afterwards
  const contentType = String(body.contentType ?? 'application/octet-stream')
  await writeMetadataSidecar(key, tenantId, sourceId, name)
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET(), Key: key, ContentType: contentType }),
    { expiresIn: 3600 },
  )
  const row: SourceRow = {
    tenantId, sourceId, name, type, s3Key: key,
    status: 'awaiting_upload', createdAt: now, updatedAt: now,
  }
  await putSource(row)
  return json(201, { source: row, uploadUrl })
}

async function tryStartIngestion(): Promise<string | undefined> {
  try {
    return await startIngestion()
  } catch (err) {
    // Another ingestion job is already running — the next one picks changes up.
    console.warn('startIngestion deferred', String(err))
    return undefined
  }
}

async function ingestSource(tenantId: string, sourceId: string): Promise<APIGatewayProxyResultV2> {
  const source = await getSource(tenantId, sourceId)
  if (!source) return json(404, { error: 'source_not_found' })
  const jobId = await tryStartIngestion()
  await updateSourceStatus(tenantId, sourceId, 'processing', jobId)
  await emitUsage({ tenantId, moduleId: 'assistant', metric: 'ingest.documents', quantity: 1 })
  return json(200, { sourceId, status: 'processing', ingestionJobId: jobId })
}

async function getSources(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const rows = await listSources(tenantId)

  // Lazily reconcile ingestion state for anything still processing.
  const jobStatuses = new Map<string, string>()
  for (const row of rows) {
    if (row.status !== 'processing') continue
    if (!row.ingestionJobId) {
      const jobId = await tryStartIngestion()
      if (jobId) await updateSourceStatus(tenantId, row.sourceId, 'processing', jobId)
      continue
    }
    if (!jobStatuses.has(row.ingestionJobId))
      jobStatuses.set(row.ingestionJobId, await getIngestionStatus(row.ingestionJobId))
    const status = jobStatuses.get(row.ingestionJobId)!
    if (status === 'COMPLETE') {
      row.status = 'ready'
      await updateSourceStatus(tenantId, row.sourceId, 'ready')
    } else if (status === 'FAILED') {
      row.status = 'failed'
      await updateSourceStatus(tenantId, row.sourceId, 'failed')
    }
  }
  return json(200, { sources: rows })
}

async function removeSource(tenantId: string, sourceId: string): Promise<APIGatewayProxyResultV2> {
  const source = await getSource(tenantId, sourceId)
  if (!source) return json(404, { error: 'source_not_found' })
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: BUCKET(),
      Delete: { Objects: [{ Key: source.s3Key }, { Key: `${source.s3Key}.metadata.json` }] },
    }),
  )
  await deleteSource(tenantId, sourceId)
  await tryStartIngestion() // prune vectors for the removed document
  return json(200, { deleted: sourceId })
}

// ── Config & conversations ───────────────────────────────────────────────

async function updateConfig(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const config = {
    tenantId,
    name: String(body.name ?? DEFAULT_CONFIG.name).slice(0, 60),
    greeting: String(body.greeting ?? DEFAULT_CONFIG.greeting).slice(0, 300),
    instructions: String(body.instructions ?? '').slice(0, 2000),
    fallbackMessage: String(body.fallbackMessage ?? DEFAULT_CONFIG.fallbackMessage).slice(0, 300),
    brandColor: /^#[0-9a-fA-F]{6}$/.test(String(body.brandColor)) ? body.brandColor : DEFAULT_CONFIG.brandColor,
    helpEnabled: body.helpEnabled === true,
    helpTitle: String(body.helpTitle ?? '').slice(0, 80),
    helpIntro: String(body.helpIntro ?? '').slice(0, 300),
  }
  await putConfig(config)
  return json(200, { config })
}

/** Publishing is per source and opt-in: a document is private until asked. */
async function setPublished(
  tenantId: string,
  sourceId: string,
  event: Event,
): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const source = await getSource(tenantId, sourceId)
  if (!source) return json(404, { error: 'not_found' })
  if (source.status !== 'ready' && body.published === true) {
    return json(409, { error: 'not_ready', message: 'Wait until this source has finished processing.' })
  }
  const updated: SourceRow = { ...source, published: body.published === true, updatedAt: new Date().toISOString() }

  // First publish (or explicit regenerate): one model call turns a filename
  // into a customer-facing title, a one-line description and a category the
  // help centre groups by. Best-effort - publishing never fails on it.
  if (body.published === true && (!updated.helpMeta || body.regenerate === true)) {
    const text = await sourceText(source)
    if (text) {
      const tenant = await getTenant(tenantId)
      const meta = await generateHelpMeta(tenant?.name ?? '', source.name, text)
      if (meta) updated.helpMeta = meta
    }
  }

  await putSource(updated)
  return json(200, { source: updated })
}

async function conversations(tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const sessionId = event.queryStringParameters?.sessionId
  if (sessionId) {
    const messages = await getSessionMessages(tenantId, String(sessionId), 50)
    return json(200, { sessionId, messages })
  }

  // Inbox: group the recent window into per-session summaries.
  const recent = await listRecentMessages(tenantId)
  const bySession = new Map<string, MessageRow[]>()
  for (const m of recent) {
    if (!bySession.has(m.sessionId)) bySession.set(m.sessionId, [])
    bySession.get(m.sessionId)!.push(m)
  }

  const sessions = [...bySession.entries()].map(([id, msgs]) => {
    const ordered = [...msgs].sort((a, b) => a.sk.localeCompare(b.sk))
    const firstQuestion = ordered.find((m) => m.role === 'user')?.text ?? ''
    const lastMessage = ordered[ordered.length - 1]
    const answers = ordered.filter((m) => m.role === 'assistant')
    return {
      sessionId: id,
      firstQuestion,
      lastAt: lastMessage.sk.split('#')[0],
      messageCount: ordered.length,
      unansweredCount: answers.filter((m) => m.fallback).length,
      thumbsDownCount: answers.filter((m) => m.feedback === 'down').length,
      thumbsUpCount: answers.filter((m) => m.feedback === 'up').length,
    }
  })
  sessions.sort((a, b) => b.lastAt.localeCompare(a.lastAt))

  const filter = event.queryStringParameters?.filter
  const filtered =
    filter === 'attention'
      ? sessions.filter((s) => s.unansweredCount > 0 || s.thumbsDownCount > 0)
      : sessions
  return json(200, { sessions: filtered, windowMessages: recent.length })
}

async function insights(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const recent = await listRecentMessages(tenantId)
  const answers = recent.filter((m) => m.role === 'assistant')
  const unanswered = answers.filter((m) => m.fallback)

  const byDay = new Map<string, { conversations: Set<string>; answers: number; unanswered: number }>()
  for (const m of recent) {
    const day = m.sk.slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, { conversations: new Set(), answers: 0, unanswered: 0 })
    const d = byDay.get(day)!
    d.conversations.add(m.sessionId)
    if (m.role === 'assistant') {
      d.answers++
      if (m.fallback) d.unanswered++
    }
  }

  // The question that triggered each fallback is the user message just before it.
  const ordered = [...recent].sort((a, b) => a.sk.localeCompare(b.sk))
  const topUnanswered: string[] = []
  for (let i = 0; i < ordered.length; i++) {
    const m = ordered[i]
    if (m.role !== 'assistant' || !m.fallback) continue
    for (let j = i - 1; j >= 0; j--) {
      if (ordered[j].sessionId === m.sessionId && ordered[j].role === 'user') {
        topUnanswered.push(ordered[j].text)
        break
      }
    }
  }

  return json(200, {
    totals: {
      conversations: new Set(recent.map((m) => m.sessionId)).size,
      answers: answers.length,
      unanswered: unanswered.length,
      resolutionRate: answers.length ? Math.round(((answers.length - unanswered.length) / answers.length) * 100) : null,
      thumbsUp: answers.filter((m) => m.feedback === 'up').length,
      thumbsDown: answers.filter((m) => m.feedback === 'down').length,
    },
    daily: [...byDay.entries()]
      .map(([day, d]) => ({ day, conversations: d.conversations.size, answers: d.answers, unanswered: d.unanswered }))
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-14),
    topUnanswered: topUnanswered.slice(-10).reverse(),
    windowMessages: recent.length,
  })
}

// ── Website knowledge and previews ───────────────────────────────────────

async function discover(event: Event): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  try {
    const { urls, source } = await discoverPages(String(body.url ?? ''))
    return json(200, { urls, discoveredVia: source })
  } catch (err) {
    return json(400, { error: 'discover_failed', message: err instanceof Error ? err.message : 'Could not read that site.' })
  }
}

/** Re-fetch a URL source in place, so refreshing never duplicates a page. */
async function refresh(tenantId: string, sourceId: string): Promise<APIGatewayProxyResultV2> {
  const source = await getSource(tenantId, sourceId)
  if (!source) return json(404, { error: 'source_not_found' })
  if (source.type !== 'url' || !source.sourceUrl) return json(400, { error: 'not_a_url_source' })

  try {
    const page = await scrapePage(source.sourceUrl)
    if (page.charCount === 0) return json(422, { error: 'no_text_extracted', warning: page.warning })
    const stored = `Source: ${page.url}

${page.text}`
    await s3.send(new PutObjectCommand({ Bucket: BUCKET(), Key: source.s3Key, Body: stored, ContentType: 'text/plain' }))
    const now = new Date().toISOString()
    await putSource({
      ...source,
      status: 'processing',
      sizeBytes: stored.length,
      charCount: page.charCount,
      warning: page.warning,
      fetchedAt: now,
      updatedAt: now,
    })
    const jobId = await tryStartIngestion()
    if (jobId) await updateSourceStatus(tenantId, sourceId, 'processing', jobId)
    return json(200, { sourceId, charCount: page.charCount, warning: page.warning, fetchedAt: now })
  } catch (err) {
    return json(400, { error: 'refresh_failed', message: err instanceof Error ? err.message : 'Could not fetch that page.' })
  }
}

/**
 * What the assistant actually learned from a source. Businesses will not put
 * an assistant in front of customers without being able to check this.
 */
async function preview(tenantId: string, sourceId: string): Promise<APIGatewayProxyResultV2> {
  const source = await getSource(tenantId, sourceId)
  if (!source) return json(404, { error: 'source_not_found' })

  const meta = {
    sourceId: source.sourceId,
    name: source.name,
    type: source.type,
    status: source.status,
    sizeBytes: source.sizeBytes ?? null,
    charCount: source.charCount ?? null,
    sourceUrl: source.sourceUrl ?? null,
    fetchedAt: source.fetchedAt ?? null,
    warning: source.warning ?? null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  }

  // Text and scraped pages are stored as plain text, so show the real content.
  if (source.type === 'text' || source.type === 'url') {
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET(), Key: source.s3Key }))
      const full = (await obj.Body?.transformToString()) ?? ''
      return json(200, {
        ...meta,
        excerpt: full.slice(0, 4000),
        truncated: full.length > 4000,
      })
    } catch {
      return json(200, { ...meta, excerpt: null, truncated: false })
    }
  }

  // Uploaded files keep their original format; hand back a short-lived link
  // rather than trying to render them server-side.
  const viewUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET(), Key: source.s3Key }), {
    expiresIn: 300,
  })
  return json(200, { ...meta, excerpt: null, truncated: false, viewUrl })
}
