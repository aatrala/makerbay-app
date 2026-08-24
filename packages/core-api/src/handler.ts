import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import {
  freeModuleLimits,
  freeModules,
  createTenant,
  deleteApiKey,
  generateApiKey,
  getEntitlements,
  getMonthUsage,
  getTenant,
  getTenantBySlug,
  getUser,
  isValidSlug,
  listApiKeys,
  putApiKey,
  MODULES,
  PLATFORM_VERSION,
  SCOPES_BY_KEY_TYPE,
  setModuleEntitlement,
  slugCandidates,
  ulid,
  updateTenantName,
  updateTenantSlug,
  type ApiKeyRow,
  type CallerContext,
  type ModuleEntitlement,
} from '@makerbay/core'

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

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

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
    if (method === 'GET' && path === '/v1/core/workspace/slug') return await checkSlug(event)
    if (method === 'PATCH' && path === '/v1/core/workspace') return await patchWorkspace(ctx, event)
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

  const now = new Date().toISOString()
  const tenant = {
    tenantId: ulid(),
    name,
    slug: await pickSlug(name),
    plan: 'free',
    status: 'active' as const,
    createdAt: now,
  }
  await createTenant(tenant, {
    userId: ctx.userId,
    email: ctx.email || undefined,
    tenantId: tenant.tenantId,
    role: 'owner',
    createdAt: now,
  })
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
    if (!(await getTenantBySlug(candidate))) return candidate
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
  const taken = await getTenantBySlug(slug)
  return json(200, { slug, available: !taken, reason: taken ? 'taken' : undefined })
}

async function patchWorkspace(ctx: CallerContext, event: Event): Promise<APIGatewayProxyResultV2> {
  const tenantId = await requireOwner(ctx)
  if (!tenantId) return json(403, { error: 'owner_required' })
  const body = JSON.parse(event.body ?? '{}')

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
      await updateTenantSlug(tenantId, slug)
    }
  }

  return json(200, { tenant: await getTenant(tenantId) })
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
  await setModuleEntitlement(tenantId, moduleId, catalogEntry)
  return json(200, { moduleId, entitlement: catalogEntry })
}

async function usage(ctx: CallerContext): Promise<APIGatewayProxyResultV2> {
  const tenantId = await freshTenantId(ctx)
  if (!tenantId) return json(404, { error: 'no_tenant' })
  const yyyymm = new Date().toISOString().slice(0, 7)
  return json(200, { month: yyyymm, totals: await getMonthUsage(tenantId, yyyymm) })
}
