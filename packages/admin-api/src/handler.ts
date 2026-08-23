import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import {
  ddb,
  getEffectiveEntitlement,
  getMonthUsage,
  getTenant,
  grantManual,
  listGrants,
  MODULES,
  PLATFORM_VERSION,
  revokeGrant,
  ulid,
  type Grant,
} from '@makerbay/core'

/**
 * Staff-facing admin API. Its purpose in v1 is narrow and worth stating:
 * replace unaudited hand edits of DynamoDB with guarded, audited writes.
 *
 * It lives on its own gateway and its own Lambda so that admin routes do not
 * exist on the customer API at all — a stronger guarantee than "the route
 * table is configured correctly".
 */

interface StaffContext {
  staffSub: string
  staffEmail: string
  staffRole: string
}
type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<StaffContext>

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const PLANS: Record<string, Record<string, number>> = {
  free: { messagesPerMonth: 200, sources: 20, sourceBytes: 25 * 1024 * 1024 },
  pro: { messagesPerMonth: 100000, sources: 500, sourceBytes: 2 * 1024 * 1024 * 1024 },
}

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const staff = event.requestContext.authorizer.lambda
  const method = event.requestContext.http.method
  const path = event.rawPath

  try {
    if (method === 'GET' && path === '/admin/v1/whoami') {
      return json(200, { staff, platform: PLATFORM_VERSION, modules: MODULES.map((m) => m.id) })
    }
    if (method === 'GET' && path === '/admin/v1/tenants') return await listTenants()

    const detail = path.match(/^\/admin\/v1\/tenants\/([A-Z0-9]+)$/)
    if (method === 'GET' && detail) return await tenantDetail(detail[1])

    const grantPath = path.match(/^\/admin\/v1\/tenants\/([A-Z0-9]+)\/grants$/)
    if (method === 'POST' && grantPath) return await createGrant(staff, grantPath[1], event)

    const revokePath = path.match(/^\/admin\/v1\/tenants\/([A-Z0-9]+)\/grants\/revoke$/)
    if (method === 'POST' && revokePath) return await revoke(staff, revokePath[1], event)

    return json(404, { error: 'not_found' })
  } catch (err) {
    console.error('admin error', { path, method, err })
    return json(500, { error: 'internal_error' })
  }
}

/**
 * Append-only audit. The admin role has PutItem on this table and nothing
 * else, so this Lambda physically cannot rewrite or delete its own trail.
 */
async function audit(
  staff: StaffContext,
  action: string,
  targetTenantId: string,
  detail: Record<string, unknown>,
  result: 'ok' | 'denied' | 'error' = 'ok',
): Promise<void> {
  const now = new Date().toISOString()
  await ddb.send(
    new PutCommand({
      TableName: process.env.TABLE_ADMINAUDIT!,
      Item: {
        pk: `AUDIT#${now.slice(0, 7)}`,
        sk: `${now}#${ulid()}`,
        ts: now,
        staffSub: staff.staffSub,
        staffEmail: staff.staffEmail,
        staffRole: staff.staffRole,
        action,
        targetTenantId,
        detail,
        result,
      },
    }),
  )
}

async function listTenants(): Promise<APIGatewayProxyResultV2> {
  // Small table at this stage; revisit when tenant count makes a scan silly.
  const r = await ddb.send(new ScanCommand({ TableName: process.env.TABLE_TENANTS! }))
  const tenants = (r.Items ?? []).map((t) => ({
    tenantId: t.tenantId,
    name: t.name,
    slug: t.slug,
    plan: t.plan,
    status: t.status,
    subscriptionStatus: t.subscriptionStatus ?? 'none',
    createdAt: t.createdAt,
  }))
  tenants.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return json(200, { tenants, count: tenants.length })
}

async function tenantDetail(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const tenant = await getTenant(tenantId)
  if (!tenant) return json(404, { error: 'tenant_not_found' })

  const [grants, usage] = await Promise.all([
    listGrants(tenantId),
    getMonthUsage(tenantId, new Date().toISOString().slice(0, 7)),
  ])
  const entitlements: Record<string, unknown> = {}
  for (const m of MODULES) entitlements[m.id] = await getEffectiveEntitlement(tenantId, m.id)

  return json(200, {
    tenant: {
      tenantId: tenant.tenantId,
      name: tenant.name,
      slug: tenant.slug,
      plan: tenant.plan,
      status: tenant.status,
      subscriptionStatus: tenant.subscriptionStatus ?? 'none',
      currentPeriodEnd: tenant.currentPeriodEnd ?? null,
      // Identifiers only — never secret material.
      stripeCustomerId: tenant.stripeCustomerId ?? null,
      createdAt: tenant.createdAt,
    },
    entitlements,
    grants: grants.map((g: Grant) => ({
      sk: g.sk, source: g.source, moduleId: g.moduleId, planTier: g.planTier,
      status: g.status, expiresAt: g.expiresAt ?? null, reason: g.reason ?? null,
      grantedBy: g.grantedBy, createdAt: g.createdAt,
    })),
    usage,
  })
}

/**
 * Grant a module without payment: pilots, comps, internal testing.
 *
 * A reason is required and an expiry is always set — "never" has to be asked
 * for explicitly. A comp that quietly becomes permanent is real money leaking
 * through Bedrock costs, and the expiry is what stops that happening by
 * forgetfulness.
 */
async function createGrant(
  staff: StaffContext,
  tenantId: string,
  event: Event,
): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const moduleId = String(body.moduleId ?? '')
  const planTier = String(body.planTier ?? 'pro')
  const reason = String(body.reason ?? '').trim()
  const days = Number(body.days ?? 30)

  if (!MODULES.some((m) => m.id === moduleId)) return json(400, { error: 'unknown_module' })
  if (!PLANS[planTier]) return json(400, { error: 'unknown_plan_tier' })
  if (reason.length < 10) {
    return json(400, { error: 'reason_required', message: 'Give a reason of at least 10 characters — it is recorded in the audit log.' })
  }
  const tenant = await getTenant(tenantId)
  if (!tenant) return json(404, { error: 'tenant_not_found' })

  const expiresAt =
    body.expiresAt === 'never'
      ? 'never'
      : new Date(Date.now() + Math.min(Math.max(days, 1), 365) * 864e5).toISOString()

  const grant = await grantManual({
    tenantId,
    moduleId,
    planTier,
    limits: PLANS[planTier],
    grantedBy: staff.staffEmail || staff.staffSub,
    reason,
    expiresAt,
    trial: body.trial === true,
  })

  await audit(staff, 'entitlement.grant', tenantId, {
    moduleId, planTier, expiresAt, reason, trial: body.trial === true,
  })
  return json(201, {
    grant: { sk: grant.sk, moduleId, planTier, expiresAt: grant.expiresAt ?? 'never', reason },
  })
}

async function revoke(staff: StaffContext, tenantId: string, event: Event): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const sk = String(body.sk ?? '')
  const reason = String(body.reason ?? '').trim()
  if (!sk.startsWith('GRANT#')) return json(400, { error: 'grant_key_required' })
  if (sk.endsWith('#stripe')) {
    await audit(staff, 'entitlement.revoke', tenantId, { sk }, 'denied')
    return json(400, {
      error: 'cannot_revoke_stripe_grant',
      message: 'A Stripe-backed grant follows the subscription. Cancel it in Stripe instead.',
    })
  }
  if (reason.length < 10) return json(400, { error: 'reason_required' })

  await revokeGrant(tenantId, sk)
  await audit(staff, 'entitlement.revoke', tenantId, { sk, reason })
  return json(200, { revoked: sk })
}
