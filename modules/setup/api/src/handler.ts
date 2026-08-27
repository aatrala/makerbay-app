import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
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
import { scrapePage } from '@makerbay/scrape'
import { extractFacts, type ExtractedFacts } from './extract'
import { getJob, listArtifacts, listJobs, putArtifact, putJob, type JobArtifact, type JobRow } from './db'

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

  const url = String(b.url ?? '').trim()
  if (!url) {
    return json(400, { error: 'url_required', message: 'Give us a website, Facebook page or listing to read.' })
  }

  const jobId = ulid()
  const job: JobRow = {
    tenantId,
    jobId,
    kind: 'presence.page',
    status: 'working',
    // Frozen here. A URL found inside the scraped page is never followed, and
    // a step wanting a resource outside this list fails the job rather than
    // quietly widening it.
    plan: {
      resources: ['presence.config'],
      sourceUrls: [url],
      steps: ['Read the page', 'Draft your page', 'Show you the changes'],
    },
    priceCents: 0,
    scopes: ['presence:config:write'],
    reviseCount: 0,
    createdBy: ctx.userId ?? 'unknown',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await putJob(job)

  let facts: ExtractedFacts
  let excerpt = ''
  try {
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
    facts = await extractFacts(page.text)
  } catch (err) {
    await putJob({ ...job, status: 'failed', error: String((err as Error).message ?? err).slice(0, 200) })
    return json(200, {
      job: { ...job, status: 'failed' },
      message: 'We could not read that address. Check it opens in a browser, or paste your details instead.',
    })
  }

  const current = await readPresence(tenantId)
  const artifact = stageArtifact(tenantId, jobId, facts, current, url, excerpt)
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

/** What the page says now, so the diff is against truth rather than a guess. */
async function readPresence(tenantId: string): Promise<Record<string, unknown>> {
  const r = await ddb.send(new GetCommand({
    TableName: process.env.TABLE_PRESENCECONFIG!,
    Key: { tenantId },
  }))
  return (r.Item ?? {}) as Record<string, unknown>
}

const FIELDS: Array<{ key: keyof ExtractedFacts; field: string; label: string }> = [
  { key: 'headline', field: 'headline', label: 'Headline' },
  { key: 'intro', field: 'intro', label: 'Intro' },
  { key: 'phone', field: 'phone', label: 'Phone' },
  { key: 'email', field: 'email', label: 'Email' },
  { key: 'serviceAreas', field: 'serviceAreas', label: 'Areas you cover' },
]

const asText = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : String(v ?? ''))

export function stageArtifact(
  tenantId: string,
  jobId: string,
  facts: ExtractedFacts,
  current: Record<string, unknown>,
  url: string,
  excerpt: string,
): JobArtifact {
  const proposed: Record<string, unknown> = {}
  const diff: JobArtifact['diff'] = []
  const provenance: JobArtifact['provenance'] = {}

  for (const { key, field, label } of FIELDS) {
    const value = facts[key]
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue
    // Never overwrite something the owner already wrote. A blank field is an
    // opportunity; a filled one is a decision they made.
    if (asText(current[field]).trim()) continue
    proposed[field] = value
    diff.push({ field, label, from: '(empty)', to: asText(value) })
    // Every fact carries the URL and the sentence it came from, so a human
    // reading the diff can check the claim against its source. That catches
    // what a validator cannot.
    provenance[field] = { url, excerpt }
  }

  return {
    pk: `${tenantId}#${jobId}`,
    sk: `ARTIFACT#presence.config#${ulid()}`,
    jobId,
    kind: 'presence.config',
    proposed,
    current,
    diff,
    provenance,
    status: 'staged',
  }
}

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
    const live = await readPresence(tenantId)
    const moved = a.diff.find((d) => (asText(live[d.field]) || '(empty)') !== d.from)
    if (moved) {
      return json(409, {
        error: 'changed_since',
        message: `Your ${moved.label.toLowerCase()} changed since we built this, so we have not applied any of it. Ask for another look and we will redo it.`,
      })
    }
    const r = await apiCall('PUT', '/v1/presence/config', auth, { ...live, ...a.proposed })
    if (!r.ok) {
      return json(409, { error: 'apply_failed', message: String(r.body.message ?? 'That did not save.') })
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
