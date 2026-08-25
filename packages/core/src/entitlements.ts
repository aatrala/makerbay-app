import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, getEntitlements } from './db'
import { ulid } from './ids'
import { freeModuleLimits, isFreeModule } from './version'

/**
 * Entitlements are stored as individual grants rather than one mutable
 * document, and the effective entitlement is computed at read time.
 *
 * The reason is structural rather than stylistic: the Stripe webhook writes
 * exactly one fixed sort key, so it *cannot* express "remove the comp the
 * founder granted". With a single document, every writer had to understand
 * every other writer, and a subscription event silently wiped manual grants.
 */

export type GrantSource = 'stripe' | 'manual' | 'trial' | 'included'

export interface Grant {
  tenantId: string
  sk: string
  source: GrantSource
  moduleId: string
  planTier: string
  limits: Record<string, number>
  status: 'active' | 'inactive' | 'revoked'
  expiresAt?: string
  grantedBy: string
  reason?: string
  overage: 'billed' | 'block'
  stripeSubscriptionId?: string
  stripeEventCreated?: number
  createdAt: string
  updatedAt: string
}

export interface EffectiveEntitlement {
  enabled: boolean
  planTier: string
  limits: Record<string, number>
  /** Only a Stripe-backed paid grant may bill overage; comps hard-stop. */
  overage: 'billed' | 'block'
  sources: GrantSource[]
}

const TABLE = () => process.env.TABLE_GRANTS!

/**
 * The free tier is a code constant, not a grant. Nobody can delete it or
 * forget to create it, so an expiring grant always degrades to something
 * rather than to nothing.
 */
export const FREE_BASELINE: Record<string, { enabled: boolean; limits: Record<string, number> }> = {
  assistant: {
    enabled: false, // enabled per tenant when the module is switched on
    limits: { messagesPerMonth: 200, sources: 20, sourceBytes: 25 * 1024 * 1024 },
  },
}

const TIER_ORDER = ['free', 'pro']
const higherTier = (a: string, b: string) =>
  TIER_ORDER.indexOf(b) > TIER_ORDER.indexOf(a) ? b : a

export const stripeGrantKey = (moduleId: string) => `GRANT#${moduleId}#stripe`

export async function listGrants(tenantId: string, moduleId?: string): Promise<Grant[]> {
  const prefix = moduleId ? `GRANT#${moduleId}#` : 'GRANT#'
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: 'tenantId = :t AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':t': tenantId, ':p': prefix },
    }),
  )
  return (r.Items ?? []) as Grant[]
}

const isLive = (g: Grant, now: string) =>
  g.status === 'active' && (!g.expiresAt || g.expiresAt > now)

/**
 * Effective entitlement: the free baseline, then the field-wise maximum of
 * every live grant. A manual grant can only ever add, so a comp cannot
 * accidentally reduce a paying customer and Stripe churn cannot erase a comp.
 */
export function resolveEntitlement(
  moduleId: string,
  grants: Grant[],
  enabledBaseline: boolean,
  now = new Date().toISOString(),
): EffectiveEntitlement {
  const live = grants.filter((g) => g.moduleId === moduleId && isLive(g, now))
  const baseline = FREE_BASELINE[moduleId]?.limits ?? {}

  const limits: Record<string, number> = { ...baseline }
  let planTier = 'free'
  for (const g of live) {
    planTier = higherTier(planTier, g.planTier)
    for (const [k, v] of Object.entries(g.limits ?? {})) {
      limits[k] = Math.max(limits[k] ?? 0, v)
    }
  }

  return {
    enabled: enabledBaseline || live.length > 0,
    planTier,
    limits,
    overage: live.some((g) => g.source === 'stripe' && g.planTier !== 'free') ? 'billed' : 'block',
    sources: [...new Set(live.map((g) => g.source))],
  }
}

/**
 * Write the Stripe grant. The sort key is a fixed literal and the condition
 * refuses to land on any item that isn't already the Stripe grant, so a
 * webhook can never overwrite a human's grant. Stripe does not guarantee
 * event ordering, so an older event cannot overwrite a newer one.
 */
export async function putStripeGrant(params: {
  tenantId: string
  moduleId: string
  planTier: string
  limits: Record<string, number>
  active: boolean
  stripeSubscriptionId?: string
  stripeEventCreated: number
}): Promise<void> {
  const now = new Date().toISOString()
  await ddb.send(
    new PutCommand({
      TableName: TABLE(),
      Item: {
        tenantId: params.tenantId,
        sk: stripeGrantKey(params.moduleId),
        source: 'stripe',
        moduleId: params.moduleId,
        planTier: params.planTier,
        limits: params.limits,
        status: params.active ? 'active' : 'inactive',
        overage: 'billed',
        grantedBy: 'stripe-webhook',
        stripeSubscriptionId: params.stripeSubscriptionId,
        stripeEventCreated: params.stripeEventCreated,
        createdAt: now,
        updatedAt: now,
      } satisfies Grant,
      ConditionExpression:
        '(attribute_not_exists(sk) OR #src = :stripe) AND (attribute_not_exists(stripeEventCreated) OR stripeEventCreated <= :created)',
      ExpressionAttributeNames: { '#src': 'source' },
      ExpressionAttributeValues: { ':stripe': 'stripe', ':created': params.stripeEventCreated },
    }),
  )
}

/**
 * Grant module access without payment. Expiry is required in practice: the
 * default is 30 days and "never" has to be chosen deliberately, so a comp
 * cannot silently become a permanent free upgrade.
 */
export async function grantManual(params: {
  tenantId: string
  moduleId: string
  planTier: string
  limits: Record<string, number>
  grantedBy: string
  reason: string
  expiresAt?: string | 'never'
  trial?: boolean
}): Promise<Grant> {
  const now = new Date().toISOString()
  const expiresAt =
    params.expiresAt === 'never'
      ? undefined
      : params.expiresAt ?? new Date(Date.now() + 30 * 864e5).toISOString()

  const grant: Grant = {
    tenantId: params.tenantId,
    sk: `GRANT#${params.moduleId}#${params.trial ? 'trial' : 'manual'}#${ulid()}`,
    source: params.trial ? 'trial' : 'manual',
    moduleId: params.moduleId,
    planTier: params.planTier,
    limits: params.limits,
    status: 'active',
    expiresAt,
    grantedBy: params.grantedBy,
    reason: params.reason,
    overage: 'block',
    createdAt: now,
    updatedAt: now,
  }
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: grant }))
  return grant
}

/** Revoked rather than deleted, so the record of who granted what survives. */
export async function revokeGrant(tenantId: string, sk: string): Promise<void> {
  if (sk === stripeGrantKey(sk.split('#')[1])) throw new Error('cannot_revoke_stripe_grant')
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { tenantId, sk },
      UpdateExpression: 'SET #s = :revoked, updatedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':revoked': 'revoked', ':now': new Date().toISOString() },
      ConditionExpression: 'attribute_exists(sk)',
    }),
  )
}

export async function deleteGrant(tenantId: string, sk: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { tenantId, sk } }))
}

/**
 * What a tenant may actually do with a module right now: the module's on/off
 * switch combined with every live grant. Expiry is evaluated here, on the read
 * path, so no sweeper job is needed and an expired grant simply stops counting.
 */
export async function getEffectiveEntitlement(
  tenantId: string,
  moduleId: string,
): Promise<EffectiveEntitlement> {
  // Free modules are on for everyone. There is nothing to switch on, nothing
  // to grant and nothing to bill, so they never touch the grant path at all.
  if (isFreeModule(moduleId)) {
    return {
      enabled: true,
      planTier: 'free',
      limits: freeModuleLimits(moduleId),
      overage: 'block',
      sources: ['included'],
    }
  }

  const [enabledMap, grants] = await Promise.all([
    getEntitlements(tenantId),
    listGrants(tenantId, moduleId),
  ])
  return resolveEntitlement(moduleId, grants, Boolean(enabledMap.modules[moduleId]?.enabled))
}

/**
 * "Is this a paying workspace" for tier-split behaviour (instant vs digest
 * notifications, ticket priority): a pro assistant plan or any live grant
 * counts - a comp is a paying customer in every way that matters here.
 */
export async function isPaidWorkspace(tenantId: string): Promise<boolean> {
  const [ent, grants] = await Promise.all([getEntitlements(tenantId), listGrants(tenantId)])
  const now = new Date().toISOString()
  return (
    ent.modules.assistant?.plan === 'pro' ||
    grants.some((g) => g.status === 'active' && (!g.expiresAt || g.expiresAt > now))
  )
}
