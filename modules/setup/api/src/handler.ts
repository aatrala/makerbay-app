import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { apiCall } from '@makerbay/agent-kit'
import {
  ddb,
  getEffectiveEntitlement,
  json,
  recordAudit,
  requireScope,
  ulid,
  type CallerContext,
} from '@makerbay/core'
import { discoverPages, scrapePage } from '@makerbay/scrape'
import { EMPTY, extractFacts } from './extract'
import { KINDS, type CurrentState, type StageInput } from './kinds'
import { getJob, listArtifacts, listJobs, putArtifact, putJob, type JobArtifact, type JobKind, type JobRow } from './db'

/**
 * "Set it up for me" - the agent does the setup, the owner approves it, and
 * nothing reaches a live surface until they do. See docs/spec-concierge.md.
 *
 * Phase 1 ships one job, for signed-in owners, on paid plans only. That is
 * deliberate rather than a shortcut: the founder's pricing decision makes
 * these jobs free on any paid plan, so phase 1 needs no payment code at all.
 * Free-tier pricing and the stranger flow arrive with Stripe in a later phase.
 */

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

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

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method
  const path = event.rawPath
  try {
    const ctx = event.requestContext.authorizer.lambda
    const tenantId = ctx.tenantId
    if (!tenantId) return json(401, { error: 'unauthorized' })

    if (method === 'GET' && path === '/v1/setup/jobs') {
      return json(200, { jobs: await listJobs(tenantId) })
    }
    if (method === 'POST' && path === '/v1/setup/jobs') {
      return await startJob(tenantId, ctx, body(event))
    }
    const m = path.match(/^\/v1\/setup\/jobs\/([0-9A-Z]{26})(\/confirm|\/release)?$/)
    if (m) {
      const jobId = m[1]
      if (method === 'GET' && !m[2]) return await readJob(tenantId, jobId)
      if (method === 'POST' && m[2] === '/confirm') return await confirmJob(tenantId, jobId, event, ctx)
      if (method === 'POST' && m[2] === '/release') return await releaseJob(tenantId, jobId)
    }
    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('setup error', { path, method, err })
    return json(500, { error: 'internal_error' })
  }
}

/**
 * Scope, read, stage. The whole job runs inline in phase 1 because one page
 * fits comfortably inside the Lambda timeout. The spec's state machine arrives
 * when a job first needs to outlive a single invocation.
 */
async function startJob(
  tenantId: string,
  ctx: CallerContext,
  b: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const presence = await getEffectiveEntitlement(tenantId, 'presence')
  if (presence.planTier === 'free') {
    return json(402, {
      error: 'plan_required',
      message: 'Having us set your page up comes with a paid plan. You can still do all of it yourself in Your page, and it takes about ten minutes.',
    })
  }

  const kind: JobKind = b.kind === 'booking.services' ? 'booking.services' : 'presence.page'
  const def = KINDS[kind]
  const url = String(b.url ?? '').trim()
  if (!url) {
    return json(400, { error: 'url_required', message: 'Give us a website, Facebook page or listing to read.' })
  }

  const jobId = ulid()
  const job: JobRow = {
    tenantId,
    jobId,
    kind,
    status: 'working',
    // Frozen here. A URL found inside the scraped page is never followed, and
    // a step wanting a resource outside this list fails the job rather than
    // quietly widening it.
    plan: {
      resources: def.resources,
      sourceUrls: [url],
      steps: ['Read the page', `Draft ${def.label.toLowerCase()}`, 'Show you the changes'],
    },
    priceCents: 0,
    scopes: def.scopes,
    reviseCount: 0,
    createdBy: ctx.userId ?? 'unknown',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await putJob(job)

  let input: StageInput = { facts: EMPTY, pages: [] }
  let excerpt = ''
  try {
    if (def.read === 'site') {
      // A site walk needs no model at all: the pages are the proposal, and
      // the assistant reads each one itself once the owner says yes.
      const found = await discoverPages(url, 60)
      if (found.urls.length === 0) {
        await putJob({ ...job, status: 'needs_you', error: 'nothing_to_read' })
        return json(200, {
          job: { ...job, status: 'needs_you' },
          message: 'We could not find any pages to read on that address. Check it opens in a browser, or add pages yourself under Assistant, Knowledge.',
        })
      }
      input = { facts: EMPTY, pages: found.urls }
      excerpt = `${found.urls.length} pages found via ${found.source}`
    } else {
      const page = await scrapePage(url)
      if (!page.text || page.text.trim().length < 80) {
        // Refusing is the honest answer. A made-up page is worse than no page,
        // and inventing one would break the same rule presence/copy.ts holds.
        await putJob({ ...job, status: 'needs_you', error: 'nothing_to_read' })
        return json(200, {
          job: { ...job, status: 'needs_you' },
          message: 'There was not enough on that page to work from, and we are not going to make up a business. Paste your price list and a couple of lines about what you do, and we will build it from that.',
        })
      }
      excerpt = page.text.slice(0, 400)
      input = { facts: await extractFacts(page.text), pages: [] }
    }
  } catch (err) {
    await putJob({ ...job, status: 'failed', error: String((err as Error).message ?? err).slice(0, 200) })
    return json(200, {
      job: { ...job, status: 'failed' },
      message: 'We could not read that address. Check it opens in a browser, or paste your details instead.',
    })
  }

  const current = await readCurrent(tenantId)
  const artifact = stageArtifact(tenantId, jobId, kind, input, current, url, excerpt)
  if (artifact.diff.length === 0) {
    await putJob({ ...job, status: 'needs_you', error: 'nothing_to_change' })
    return json(200, {
      job: { ...job, status: 'needs_you' },
      message: 'Your page already says everything we found on that site, so there is nothing for us to change.',
    })
  }
  await putArtifact(artifact)
  await putJob({ ...job, status: 'ready' })
  return json(201, { job: { ...job, status: 'ready' }, artifact })
}

const asText = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : String(v ?? ''))

/** What the workspace looks like now, so a diff is against truth. */
async function readCurrent(tenantId: string): Promise<CurrentState> {
  const get = async (table?: string): Promise<Record<string, unknown>> => {
    if (!table) return {}
    try {
      const r = await ddb.send(new GetCommand({ TableName: table, Key: { tenantId } }))
      return (r.Item ?? {}) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const list = async <T>(table?: string): Promise<T[]> => {
    if (!table) return []
    try {
      const r = await ddb.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'tenantId = :t',
        ExpressionAttributeValues: { ':t': tenantId },
      }))
      return (r.Items ?? []) as T[]
    } catch {
      return []
    }
  }
  const [presence, services, assistant, sources, quotes] = await Promise.all([
    get(process.env.TABLE_PRESENCECONFIG),
    list<CurrentState['services'][number]>(process.env.TABLE_BOOKINGSERVICES),
    get(process.env.TABLE_ASSISTANT_CONFIG),
    list<CurrentState['sources'][number]>(process.env.TABLE_SOURCES),
    get(process.env.TABLE_QUOTESCONFIG),
  ])
  return { presence, services, assistant, sources, quotes }
}

export function stageArtifact(
  tenantId: string,
  jobId: string,
  kind: JobKind,
  input: StageInput,
  current: CurrentState,
  url: string,
  excerpt: string,
): JobArtifact {
  const { proposed, diff } = KINDS[kind].stage(input, current)
  const provenance: JobArtifact['provenance'] = {}
  // Every fact carries the URL and the sentence it came from, so a human
  // reading the diff can check the claim against its source. That catches
  // what a validator cannot.
  for (const d of diff) provenance[d.field] = { url, excerpt }
  return {
    pk: `${tenantId}#${jobId}`,
    sk: `ARTIFACT#${kind}#${ulid()}`,
    jobId,
    kind,
    proposed,
    current: current.presence,
    diff,
    provenance,
    status: 'staged',
  }
}

/** One wording for "the workspace moved underneath this plan", both kinds. */
const staleResponse = (label: string): APIGatewayProxyResultV2 =>
  json(409, {
    error: 'changed_since',
    message: `Your ${label.toLowerCase()} changed since we built this, so we have not applied any of it. Ask for another look and we will redo it.`,
  })

async function readJob(tenantId: string, jobId: string): Promise<APIGatewayProxyResultV2> {
  const job = await getJob(tenantId, jobId)
  if (!job) return json(404, { error: 'not_found' })
  return json(200, { job, artifacts: await listArtifacts(tenantId, jobId) })
}

/**
 * Apply, with the owner's own token.
 *
 * The agent never holds a credential: the write goes out over the ordinary
 * module API carrying the bearer of the person who pressed confirm, so
 * entitlements, scope, version snapshots and the audit trail all run exactly
 * as they do for a button press.
 */
async function confirmJob(
  tenantId: string,
  jobId: string,
  event: Event,
  ctx: CallerContext,
): Promise<APIGatewayProxyResultV2> {
  const job = await getJob(tenantId, jobId)
  if (!job || job.status !== 'ready') return json(404, { error: 'not_found' })

  // Only a signed-in human confirms. A key of any kind may propose all it
  // likes and may never approve its own work.
  if (!ctx.userId) {
    return json(403, {
      error: 'confirmation_requires_a_person',
      message: 'Only the owner can confirm this, signed in to their workspace.',
    })
  }
  const denied = requireScope(ctx, 'presence:config:write')
  if (denied) return denied

  const auth = event.headers?.authorization ?? event.headers?.Authorization ?? ''
  if (!auth) return json(401, { error: 'unauthorized' })

  const staged = (await listArtifacts(tenantId, jobId)).filter((a) => a.status === 'staged')
  if (staged.length === 0) return json(409, { error: 'nothing_staged' })

  for (const a of staged) {
    // Re-read and re-diff at confirm time. A preview built an hour ago may no
    // longer describe what is there, and applying a stale plan is exactly the
    // failure Genie's ten-minute card expiry existed to prevent. Here the
    // answer is to recompute rather than to expire, because an owner is meant
    // to be able to sleep on it.
    const live = await readCurrent(tenantId)

    // Every write leaves over the ordinary module API carrying the owner's
    // own token, so validation, entitlements, version snapshots and the audit
    // trail all run exactly as they do for a button press. The agent holds no
    // credential of its own.
    const fail = (body: Record<string, unknown>) =>
      json(409, { error: 'apply_failed', message: String(body.message ?? 'That did not save.') })

    if (a.kind === 'presence.page') {
      const moved = a.diff.find((d) => (asText(live.presence[d.field]) || '(empty)') !== d.from)
      if (moved) return staleResponse(moved.label)
      const r = await apiCall('PUT', '/v1/presence/config', auth, { ...live.presence, ...a.proposed })
      if (!r.ok) return fail(r.body)

    } else if (a.kind === 'booking.services') {
      // One at a time, so each service gets its own validation, snapshot and
      // audit line, exactly as if the owner had typed it.
      const known = new Set(live.services.map((sv) => sv.name.trim().toLowerCase()))
      const wanted = (a.proposed.services ?? []) as CurrentState['services']
      const already = wanted.find((sv) => known.has(sv.name.trim().toLowerCase()))
      if (already) return staleResponse(already.name)
      for (const sv of wanted) {
        const r = await apiCall('POST', '/v1/booking/services', auth, {
          name: sv.name,
          ...(sv.priceCents != null ? { priceCents: sv.priceCents } : {}),
          ...(sv.durationMinutes != null ? { durationMinutes: sv.durationMinutes } : {}),
        })
        if (!r.ok) return fail(r.body)
      }

    } else if (a.kind === 'assistant.knowledge') {
      const norm = (u: string) => u.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase()
      const known = new Set(live.sources.map((sv) => norm(sv.url ?? sv.name)))
      const pages = ((a.proposed.pages ?? []) as string[]).filter((u) => !known.has(norm(u)))
      for (const url of pages) {
        // A source cap or a plan limit refuses here the same way it would in
        // the Knowledge screen, and that refusal is the honest answer.
        const r = await apiCall('POST', '/v1/assistant/sources', auth, { type: 'url', url })
        if (!r.ok) return fail(r.body)
      }

    } else if (a.kind === 'help.centre') {
      const moved = a.diff.find((d) => {
        const now = live.assistant[d.field]
        const shown = d.field === 'helpEnabled' ? (now === true ? 'on' : 'off') : (asText(now) || '(empty)')
        return shown !== d.from
      })
      if (moved) return staleResponse(moved.label)
      // updateConfig rebuilds the whole row from the body, so the current
      // values have to travel with the change or they are cleared.
      const r = await apiCall('PUT', '/v1/assistant/config', auth, { ...live.assistant, ...a.proposed })
      if (!r.ok) return fail(r.body)

    } else {
      const moved = a.diff.find((d) => (asText(live.quotes[d.field]) || '(none)') !== d.from.split(',')[0])
      if (moved) return staleResponse(moved.label)
      const r = await apiCall('PUT', '/v1/quotes/config', auth, { ...live.quotes, ...a.proposed })
      if (!r.ok) return fail(r.body)
    }
    await putArtifact({ ...a, status: 'applied' })
  }

  await putJob({ ...job, status: 'confirmed' })
  const fields = staged.flatMap((a) => a.diff).map((d) => d.label.toLowerCase()).join(', ')
  await recordAudit({
    tenantId,
    actor: { type: 'setup', id: jobId, label: 'MakerBay setup', onBehalfOf: ctx.userId },
    origin: 'setup',
    action: 'setup.applied',
    moduleId: 'setup',
    targetId: jobId,
    // Reads back months later as MakerBay acting on their say-so, rather than
    // naming the owner for something they did not personally type.
    summary: `MakerBay setup, on your authorisation: wrote ${fields} to your page, read from ${job.plan.sourceUrls[0]}`,
  })
  return json(200, { job: { ...job, status: 'confirmed' }, applied: staged.length })
}

async function releaseJob(tenantId: string, jobId: string): Promise<APIGatewayProxyResultV2> {
  const job = await getJob(tenantId, jobId)
  if (!job) return json(404, { error: 'not_found' })
  await putJob({ ...job, status: 'released' })
  // Nothing was applied and nothing was charged, so there is nothing to undo.
  return json(200, { job: { ...job, status: 'released' } })
}
