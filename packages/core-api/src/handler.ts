import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import {
  ddb as ddbDoc,
  json,
  recordAudit,
  freeModuleLimits,
  freeModules,
  claimSlugAlias,
  createTenant,
  deleteApiKey,
  generateApiKey,
  getEntitlements,
  getMonthUsage,
  getSlugAlias,
  getTenant,
  getTenantBySlug,
  getUser,
  isValidSlug,
  listGrants,
  listSlugAliases,
  listApiKeys,
  releaseSlugAlias,
  putApiKey,
  MODULES,
  PLATFORM_VERSION,
  SCOPES_BY_KEY_TYPE,
  setModuleEntitlement,
  slugCandidates,
  currencyForLocale,
  ulid,
  setOverageOptIn,
  updateTenantName,
  updateTenantSlug,
  type ApiKeyRow,
  type CallerContext,
  type ModuleEntitlement,
} from '@makerbay/core'

import { createTicket, listTickets, replyTicket } from './support'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

// Module catalog: what can be enabled, and free-plan limits.
/**
 * What switching a paid module on gives you before any payment: a baseline
 * generous enough to prove the module works, small enough that real usage
 * needs the Pro plan. Free modules never appear here - they bypass
 * entitlements entirely (see freeModules in core).
 */
const MODULE_CATALOG: Record<string, ModuleEntitlement> = {
  assistant: {
    enabled: true,
    plan: 'free',
    limits: { messagesPerMonth: 200, sources: 20, sourceBytes: 25 * 1024 * 1024 },
  },
  booking: {
    enabled: true,
    plan: 'free',
    limits: { bookingsPerMonth: 20 },
  },
  reviews: {
    enabled: true,
    plan: 'free',
    limits: { reviewsPerMonth: 20 },
  },
}

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const ctx = event.requestContext.authorizer.lambda
  const method = event.requestContext.http.method
  const path = event.rawPath

  // Core routes are dashboard/secret-key territory. Publishable keys
  // (chat:invoke only) must never reach tenant administration.
  if (ctx.keyId && ctx.scopes !== '*') return json(403, { error: 'insufficient_scope' })

  try {
    if (method === 'POST' && path === '/v1/core/tenants') return await createWorkspace(ctx, event)
    if (method === 'GET' && path === '/v1/core/me') return await me(ctx)
    if (method === 'POST' && path === '/v1/core/keys') return await createKey(ctx, event)
    if (method === 'GET' && path === '/v1/core/keys') return await getKeys(ctx)
    if (method === 'DELETE' && path.startsWith('/v1/core/keys/')) {
      return await revokeKey(ctx, path.split('/').pop()!)
    }
    const enableMatch = path.match(/^\/v1\/core\/modules\/([a-z0-9-]+)\/enable$/)
    if (method === 'POST' && enableMatch) return await enableModule(ctx, enableMatch[1])
    const disableMatch = path.match(/^\/v1\/core\/modules\/([a-z0-9-]+)\/disable$/)
    if (method === 'POST' && disableMatch) return await disableModule(ctx, disableMatch[1])
    if (method === 'GET' && path === '/v1/core/workspace/slug') return await checkSlug(event)
    if (method === 'PATCH' && path === '/v1/core/workspace') return await patchWorkspace(ctx, event)
    if (method === 'GET' && path === '/v1/core/support/tickets') {
      const t = await freshTenantId(ctx)
      return t ? await listTickets(t) : json(404, { error: 'no_tenant' })
    }
    if (method === 'POST' && path === '/v1/core/support/tickets') {
      const t = await freshTenantId(ctx)
      return t
        ? await createTicket(t, { userId: ctx.userId, email: ctx.email }, JSON.parse(event.body ?? '{}'))
        : json(404, { error: 'no_tenant' })
    }
    const ticketReply = path.match(/^\/v1\/core\/support\/tickets\/([0-9A-Z]{26})\/reply$/)
    if (method === 'POST' && ticketReply) {
      const t = await freshTenantId(ctx)
      return t
        ? await replyTicket(t, ticketReply[1], { userId: ctx.userId, email: ctx.email }, JSON.parse(event.body ?? '{}'))
        : json(404, { error: 'no_tenant' })
    }
    if (method === 'GET' && path === '/v1/core/workspace/aliases') return await getAliases(ctx)
    if (method === 'POST' && path === '/v1/core/workspace/aliases') return await addAlias(ctx, event)
    const aliasDel = path.match(/^\/v1\/core\/workspace\/aliases\/([a-z0-9-]{3,40})$/)
    if (method === 'DELETE' && aliasDel) return await removeAlias(ctx, aliasDel[1])
    if (method === 'GET' && path === '/v1/core/activity') return await activity(ctx, event)
    if (method === 'GET' && path === '/v1/core/usage') return await usage(ctx)
    if (method === 'GET' && path === '/v1/core/version') {
      return json(200, {
        platform: PLATFORM_VERSION,
        modules: MODULES.map((m) => ({
          id: m.id, name: m.name, status: m.status, version: m.version,
        })),
      })
    }

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('core-api error', { path, method, err })
    return json(500, { error: 'internal_error' })
  }
}

// The authorizer context can be up to 5 minutes stale (result caching), so
// identity-sensitive routes resolve the caller's tenant fresh from the table.
async function freshTenantId(ctx: CallerContext): Promise<string> {
  if (ctx.keyId) return ctx.tenantId
  if (!ctx.userId) return ''
  return (await getUser(ctx.userId))?.tenantId ?? ''
}

async function requireOwner(ctx: CallerContext): Promise<string | null> {
  if (!ctx.userId) return null
  const user = await getUser(ctx.userId)
  return user && user.role === 'owner' ? user.tenantId : null
}

async function createWorkspace(ctx: CallerContext, event: Event): Promise<APIGatewayProxyResultV2> {
  if (!ctx.userId) return json(401, { error: 'user_token_required' })
  if (await freshTenantId(ctx)) return json(409, { error: 'tenant_already_exists' })

  const body = JSON.parse(event.body ?? '{}')
  const name = String(body.name ?? '').trim()
  if (!name) return json(400, { error: 'name_required' })
  // Optional and free-form (issue 83): seeds trade-flavoured defaults later
  // and tells us which trades actually sign up.
  const trade = String(body.trade ?? '').trim().slice(0, 40) || undefined
  // Detected in the browser at signup. Proved before it is stored: a bad zone
  // would silently shift every appointment this workspace ever takes, which
  // is the failure issue 77 already cost us once.
  let timezone: string | undefined
  const claimed = String(body.timezone ?? '').trim()
  if (claimed) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: claimed }).format(new Date())
      timezone = claimed.slice(0, 64)
    } catch {
      console.warn('signup sent an unknown timezone, falling back', { claimed })
    }
  }

  // Validated the same way as the timezone: an unrecognised region leaves it
  // unset rather than guessing, because a wrong currency that looks
  // deliberate gets quoted in (issue 114).
  const currency = currencyForLocale(String(body.locale ?? '').trim() || undefined)

  const now = new Date().toISOString()
  const tenant = {
    tenantId: ulid(),
    name,
    slug: await pickSlug(name),
    plan: 'free',
    status: 'active' as const,
    trade,
    timezone,
    currency,
    createdAt: now,
  }
  await createTenant(tenant, {
    userId: ctx.userId,
    email: ctx.email || undefined,
    tenantId: tenant.tenantId,
    role: 'owner',
    createdAt: now,
  })
  // Every switchable module starts ON (issue 69). The old flow enabled only
  // the assistant and nothing exposed the enable button afterwards, so new
  // owners never found Booking or Reviews. Anything unwanted is one click
  // off on the Workspace page.
  for (const [moduleId, entry] of Object.entries(MODULE_CATALOG)) {
    await setModuleEntitlement(tenant.tenantId, moduleId, entry)
  }
  return json(201, { tenant })
}

/**
 * The first free candidate: the clean business name, then readable suffixes.
 * A slug appears in every link a customer sees, so it has to be something the
 * owner can say out loud - never three random characters.
 */
async function pickSlug(name: string): Promise<string> {
  for (const candidate of slugCandidates(name)) {
    if (!isValidSlug(candidate)) continue
    if (!(await getTenantBySlug(candidate)) && !(await getSlugAlias(candidate))) return candidate
  }
  return `w-${ulid().slice(-8).toLowerCase()}`
}

async function checkSlug(event: Event): Promise<APIGatewayProxyResultV2> {
  const slug = String(event.queryStringParameters?.check ?? '').trim().toLowerCase()
  if (!isValidSlug(slug)) {
    return json(200, {
      slug,
      available: false,
      reason: 'invalid',
      message: 'Use 3-40 lowercase letters, numbers and single hyphens. Some names are reserved.',
    })
  }
  const taken = (await getTenantBySlug(slug)) ?? (await getSlugAlias(slug))
  return json(200, { slug, available: !taken, reason: taken ? 'taken' : undefined })
}

/**
 * How many public addresses a workspace may hold in total, primary included.
 * Free stays at one; Trade carries three; the Genie tier five. Extra
 * addresses 301 to the primary - a rebrand or the short name on the van
 * keeps working without splitting the page's search standing.
 */
async function aliasAllowance(tenantId: string): Promise<number> {
  const [grants, entitlements] = await Promise.all([
    listGrants(tenantId),
    getEntitlements(tenantId),
  ])
  const now = new Date().toISOString()
  const live = grants.filter((g) => g.status === 'active' && (!g.expiresAt || g.expiresAt > now))
  const genieTier =
    entitlements.modules.genie?.enabled === true ||
    live.some((g) => g.moduleId === 'genie')
  if (genieTier) return 5
  const trade =
    entitlements.modules.assistant?.plan === 'pro' ||
    live.some((g) => g.moduleId === 'assistant' && g.planTier === 'pro')
  return trade ? 3 : 1
}

async function getAliases(ctx: CallerContext): Promise<APIGatewayProxyResultV2> {
  const tenantId = await requireOwner(ctx)
  if (!tenantId) return json(403, { error: 'owner_required' })
  const [aliases, max] = await Promise.all([listSlugAliases(tenantId), aliasAllowance(tenantId)])
  return json(200, {
    aliases: aliases.map((a) => ({ slug: a.slug, createdAt: a.createdAt })),
    // The primary slug occupies one of the total.
    max: Math.max(0, max - 1),
  })
}

async function addAlias(ctx: CallerContext, event: Event): Promise<APIGatewayProxyResultV2> {
  const tenantId = await requireOwner(ctx)
  if (!tenantId) return json(403, { error: 'owner_required' })
  const body = JSON.parse(event.body ?? '{}')
  const slug = String(body.slug ?? '').trim().toLowerCase()
  if (!isValidSlug(slug)) {
    return json(400, {
      error: 'invalid_slug',
      message: 'Use 3-40 lowercase letters, numbers and single hyphens. Some names are reserved.',
    })
  }

  const [aliases, max, tenant] = await Promise.all([
    listSlugAliases(tenantId),
    aliasAllowance(tenantId),
    getTenant(tenantId),
  ])
  if (max <= 1) {
    return json(402, {
      error: 'plan_required',
      message: 'Extra addresses come with the Trade plan (3 in total) and Genie (5). Your current address keeps working.',
    })
  }
  if (aliases.length >= max - 1) {
    return json(409, {
      error: 'limit_reached',
      message: `Your plan carries ${max} addresses in total. Remove one to add another.`,
    })
  }
  if (tenant?.slug === slug) {
    return json(409, { error: 'is_primary', message: 'That is already your main address.' })
  }
  if (await getTenantBySlug(slug)) {
    return json(409, { error: 'slug_taken', message: 'That address is already in use.' })
  }

  try {
    await claimSlugAlias(slug, tenantId)
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return json(409, { error: 'slug_taken', message: 'That address is already in use.' })
    }
    throw err
  }
  await recordAudit({
    tenantId,
    actor: { type: 'user', id: ctx.userId ?? '', label: ctx.email || undefined },
    origin: 'ui',
    action: 'workspace.alias_added',
    moduleId: 'platform',
    summary: `Extra address makerbay.app/p/${slug} added - it forwards to /p/${tenant?.slug}`,
  })
  return json(201, { slug })
}

async function removeAlias(ctx: CallerContext, slug: string): Promise<APIGatewayProxyResultV2> {
  const tenantId = await requireOwner(ctx)
  if (!tenantId) return json(403, { error: 'owner_required' })
  try {
    await releaseSlugAlias(slug, tenantId)
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return json(404, { error: 'not_found' })
    }
    throw err
  }
  await recordAudit({
    tenantId,
    actor: { type: 'user', id: ctx.userId ?? '', label: ctx.email || undefined },
    origin: 'ui',
    action: 'workspace.alias_removed',
    moduleId: 'platform',
    summary: `Extra address makerbay.app/p/${slug} removed - links to it stopped working`,
  })
  return json(200, { removed: slug })
}

async function patchWorkspace(ctx: CallerContext, event: Event): Promise<APIGatewayProxyResultV2> {
  const tenantId = await requireOwner(ctx)
  if (!tenantId) return json(403, { error: 'owner_required' })
  const body = JSON.parse(event.body ?? '{}')

  // The customer's own answer to "bill me past the allowance, or stop?"
  // (issue 138). Nothing else may set it - not the Stripe webhook, which used
  // to decide this on their behalf.
  if (body.overageOptIn !== undefined) {
    await setOverageOptIn(tenantId, body.overageOptIn === true)
  }

  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 80)
    if (name.length < 2) return json(400, { error: 'name_too_short' })
    await updateTenantName(tenantId, name)
  }

  if (body.slug !== undefined) {
    const slug = String(body.slug).trim().toLowerCase()
    const current = await getTenant(tenantId)
    if (current?.slug !== slug) {
      if (!isValidSlug(slug)) {
        return json(400, {
          error: 'invalid_slug',
          message: 'Use 3-40 lowercase letters, numbers and single hyphens. Some names are reserved.',
        })
      }
      const taken = await getTenantBySlug(slug)
      if (taken && taken.tenantId !== tenantId) {
        return json(409, { error: 'slug_taken', message: 'That address is already in use.' })
      }
      // An alias holds the name too - even this workspace's own (release it
      // first rather than silently having primary and alias collide).
      const alias = await getSlugAlias(slug)
      if (alias && alias.tenantId !== tenantId) {
        return json(409, { error: 'slug_taken', message: 'That address is already in use.' })
      }
      if (alias && alias.tenantId === tenantId) {
        await releaseSlugAlias(slug, tenantId)
      }
      /**
       * Keep the old address alive (issue 118).
       *
       * Renaming used to break every quote and invoice link already sitting in
       * a customer's messages - the audit line here said so verbatim, as if it
       * were a fact of life rather than a bug. An invoice link is a payment
       * instrument people dig out months later; there is no point at which
       * silently 404ing one is acceptable.
       *
       * Claimed automatically and NOT charged against aliasAllowance: this is
       * not the owner buying a second address, it is us not breaking the first
       * one. A failure here must not fail the rename itself, so it is caught -
       * the worst case is the old behaviour, which is what we had anyway.
       */
      const previous = current?.slug
      let aliasKept = false
      if (previous && previous !== slug) {
        try {
          await claimSlugAlias(previous, tenantId)
          aliasKept = true
        } catch (err) {
          console.warn('could not keep the old address alive', { tenantId, previous, err: String(err) })
        }
      }
      await updateTenantSlug(tenantId, slug)
      await recordAudit({
        tenantId,
        actor: { type: 'user', id: ctx.userId ?? '', label: ctx.email || undefined },
        origin: 'ui',
        action: 'workspace.slug_changed',
        moduleId: 'platform',
        summary: aliasKept
          ? `Public address changed from ${previous} to ${slug} - links already sent keep working`
          : `Public address changed from ${previous ?? '?'} to ${slug} - the old address could NOT be kept, so links already sent may not work`,
      })
    }
  }

  return json(200, { tenant: await getTenant(tenantId) })
}

/**
 * The workspace activity feed, one month per request, newest first. Fed by
 * the audit writer; a brand-new month is legitimately empty.
 */
async function activity(ctx: CallerContext, event: Event): Promise<APIGatewayProxyResultV2> {
  const tenantId = await freshTenantId(ctx)
  if (!tenantId) return json(404, { error: 'no_tenant' })
  const month = /^\d{4}-\d{2}$/.test(String(event.queryStringParameters?.month))
    ? String(event.queryStringParameters?.month)
    : new Date().toISOString().slice(0, 7)
  const r = await ddbDoc.send(
    new QueryCommand({
      TableName: process.env.TABLE_AUDIT!,
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': `${tenantId}#${month}` },
      ScanIndexForward: false,
      Limit: 200,
    }),
  )
  return json(200, {
    month,
    entries: (r.Items ?? []).map((i) => ({
      ts: i.ts, actor: i.actor, origin: i.origin, action: i.action,
      moduleId: i.moduleId, summary: i.summary,
    })),
  })
}

async function me(ctx: CallerContext): Promise<APIGatewayProxyResultV2> {
  if (!ctx.userId) return json(401, { error: 'user_token_required' })
  const user = await getUser(ctx.userId)
  if (!user) return json(200, { user: { userId: ctx.userId, email: ctx.email }, tenant: null })
  const [tenant, entitlements] = await Promise.all([
    getTenant(user.tenantId),
    getEntitlements(user.tenantId),
  ])
  // Free modules are on for every workspace and have no grant behind them, so
  // they would otherwise be invisible to the dashboard. The server owns what a
  // workspace may use; the client should never have to know which are free.
  const modules = { ...entitlements.modules }
  for (const m of freeModules()) {
    modules[m.id] = {
      enabled: true,
      plan: 'free',
      limits: freeModuleLimits(m.id),
    }
  }
  // A live GRANT alone must also light the module up - a comp or a bundle
  // grant is real access, whether or not an entitlements row was written.
  const now = new Date().toISOString()
  for (const g of await listGrants(user.tenantId)) {
    if (g.status !== 'active' || (g.expiresAt && g.expiresAt <= now)) continue
    if (modules[g.moduleId]?.enabled) continue
    modules[g.moduleId] = { enabled: true, plan: g.planTier, limits: g.limits }
  }
  // Genie is for everyone: below a subscription or grant, the taster applies
  // (25 messages a month on Free, 250 on Trade) - the genie API enforces the
  // same caps, this just keeps the door visible.
  if (!modules.genie?.enabled) {
    const onTrade = modules.assistant?.plan === 'pro'
    modules.genie = {
      enabled: true,
      plan: 'taster',
      limits: { genieMessagesPerMonth: onTrade ? 250 : 25 },
    }
  }
  return json(200, { user, tenant, entitlements: { ...entitlements, modules } })
}

async function createKey(ctx: CallerContext, event: Event): Promise<APIGatewayProxyResultV2> {
  const tenantId = await requireOwner(ctx)
  if (!tenantId) return json(403, { error: 'owner_required' })

  const body = JSON.parse(event.body ?? '{}')
  const type = body.type === 'publishable' ? 'publishable' : 'secret'
  const { secret, hash } = generateApiKey(type)
  const row: ApiKeyRow = {
    tenantId,
    keyId: ulid(),
    keyHash: hash,
    type,
    scopes: SCOPES_BY_KEY_TYPE[type],
    label: String(body.label ?? '').slice(0, 64) || `${type} key`,
    createdAt: new Date().toISOString(),
  }
  await putApiKey(row)
  // The secret is returned exactly once and never stored in plaintext.
  return json(201, { keyId: row.keyId, type, label: row.label, secret })
}

async function getKeys(ctx: CallerContext): Promise<APIGatewayProxyResultV2> {
  const tenantId = await freshTenantId(ctx)
  if (!tenantId) return json(404, { error: 'no_tenant' })
  const keys = (await listApiKeys(tenantId)).map(({ keyHash: _omit, ...rest }) => rest)
  return json(200, { keys })
}

async function revokeKey(ctx: CallerContext, keyId: string): Promise<APIGatewayProxyResultV2> {
  const tenantId = await requireOwner(ctx)
  if (!tenantId) return json(403, { error: 'owner_required' })
  await deleteApiKey(tenantId, keyId)
  return json(200, { deleted: keyId })
}

async function enableModule(ctx: CallerContext, moduleId: string): Promise<APIGatewayProxyResultV2> {
  const tenantId = await requireOwner(ctx)
  if (!tenantId) return json(403, { error: 'owner_required' })
  const catalogEntry = MODULE_CATALOG[moduleId]
  if (!catalogEntry) return json(404, { error: 'unknown_module' })
  // Re-enabling after a switch-off must not stomp a paid plan's limits -
  // keep whatever entry exists and only flip the switch.
  const current = (await getEntitlements(tenantId)).modules[moduleId]
  const entitlement = { ...(current ?? catalogEntry), enabled: true }
  await setModuleEntitlement(tenantId, moduleId, entitlement)
  return json(200, { moduleId, entitlement })
}

/**
 * The other half of the switch (issue 69): hide a module the business does
 * not use. Nothing is deleted - data, config and any paid plan stay put, and
 * a module kept alive by a live paid grant simply stays on.
 */
async function disableModule(ctx: CallerContext, moduleId: string): Promise<APIGatewayProxyResultV2> {
  const tenantId = await requireOwner(ctx)
  if (!tenantId) return json(403, { error: 'owner_required' })
  const catalogEntry = MODULE_CATALOG[moduleId]
  if (!catalogEntry) return json(404, { error: 'unknown_module' })
  const current = (await getEntitlements(tenantId)).modules[moduleId]
  const entitlement = { ...(current ?? catalogEntry), enabled: false }
  await setModuleEntitlement(tenantId, moduleId, entitlement)
  return json(200, { moduleId, entitlement })
}

async function usage(ctx: CallerContext): Promise<APIGatewayProxyResultV2> {
  const tenantId = await freshTenantId(ctx)
  if (!tenantId) return json(404, { error: 'no_tenant' })
  const yyyymm = new Date().toISOString().slice(0, 7)
  return json(200, { month: yyyymm, totals: await getMonthUsage(tenantId, yyyymm) })
}
