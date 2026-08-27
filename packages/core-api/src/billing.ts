import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import {
  clearTenantBilling,
  getEffectiveEntitlement,
  getEntitlements,
  getMonthUsage,
  getTenant,
  getUser,
  json,
  setModuleEntitlement,
  setTenantBilling,
  type CallerContext,
} from '@makerbay/core'
import { ANNUAL_PRICE_CENTS, GENIE_PRODUCT_KEY, isTestMode, METER_EVENT_NAME, PLANS, PRO_PRODUCT_KEY, stripeClient } from './stripe-client'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const ctx = event.requestContext.authorizer.lambda
  const method = event.requestContext.http.method
  const path = event.rawPath

  try {
    // Billing is owner-only: never reachable with an API key.
    if (!ctx.userId) return json(403, { error: 'owner_required' })
    const user = await getUser(ctx.userId)
    if (!user || user.role !== 'owner') return json(403, { error: 'owner_required' })
    const tenant = await getTenant(user.tenantId)
    if (!tenant) return json(404, { error: 'no_tenant' })

    if (method === 'GET' && path === '/v1/core/billing/summary') return await summary(tenant)
    if (method === 'POST' && path === '/v1/core/billing/checkout') return await checkout(tenant, event)
    if (method === 'POST' && path === '/v1/core/billing/portal') return await portal(tenant)
    if (method === 'POST' && path === '/v1/core/billing/reset') return await reset(tenant, event)
    return json(404, { error: 'not_found' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'error'
    if (message === 'stripe_not_configured') {
      return json(503, { error: 'billing_not_configured' })
    }
    console.error('billing error', { path, method, err })
    return json(500, { error: 'internal_error' })
  }
}

interface TenantLike {
  tenantId: string
  name: string
  plan: string
  stripeCustomerId?: string
  subscriptionStatus?: string
  currentPeriodEnd?: string
  lastWebhookAt?: string
  lastWebhookType?: string
  lastWebhookLive?: boolean
}

async function summary(tenant: TenantLike): Promise<APIGatewayProxyResultV2> {
  // The effective entitlement is the truth: it accounts for comps and trials
  // that have no Stripe subscription behind them.
  const effective = await getEffectiveEntitlement(tenant.tenantId, 'assistant')
  const plan = PLANS[effective.planTier] ?? PLANS[tenant.plan] ?? PLANS.free
  const totals = await getMonthUsage(tenant.tenantId, new Date().toISOString().slice(0, 7))
  const messages = totals['assistant.message'] ?? 0
  const overage = Math.max(0, messages - plan.includedMessages)

  let billingConfigured = true
  try {
    await stripeClient()
  } catch {
    billingConfigured = false
  }

  return json(200, {
    plan: {
      id: plan.id,
      name: plan.name,
      monthlyPriceCents: plan.monthlyPriceCents,
      includedMessages: plan.includedMessages,
      overageCentsPerMessage: plan.overageCentsPerMessage,
    },
    plans: Object.values(PLANS).map((p) => ({
      id: p.id, name: p.name, monthlyPriceCents: p.monthlyPriceCents,
      includedMessages: p.includedMessages, overageCentsPerMessage: p.overageCentsPerMessage,
    })),
    usage: {
      messages,
      includedMessages: plan.includedMessages,
      overageMessages: overage,
      estimatedOverageCents: overage * plan.overageCentsPerMessage,
    },
    subscription: {
      status: tenant.subscriptionStatus ?? 'none',
      currentPeriodEnd: tenant.currentPeriodEnd ?? null,
      hasCustomer: Boolean(tenant.stripeCustomerId),
    },
    // Whether Stripe is reaching us, and in which mode the last event arrived.
    // A live-mode workspace whose last event was test-mode has a webhook
    // pointed at the wrong endpoint - worth saying out loud.
    webhook: {
      lastAt: tenant.lastWebhookAt ?? null,
      lastType: tenant.lastWebhookType ?? null,
      lastLive: tenant.lastWebhookLive ?? null,
    },
    entitlement: {
      planTier: effective.planTier,
      sources: effective.sources,
      overage: effective.overage,
      limits: effective.limits,
    },
    billingConfigured,
    testMode: billingConfigured ? await isTestMode() : null,
  })
}

/** Find or create the Billing Meter that backs the metered price. */
async function assistantMeter(stripe: Awaited<ReturnType<typeof stripeClient>>) {
  const existing = await stripe.billing.meters.list({ status: 'active', limit: 100 })
  const found = existing.data.find((m) => m.event_name === METER_EVENT_NAME)
  if (found) return found

  return stripe.billing.meters.create({
    display_name: 'MakerBay assistant messages',
    event_name: METER_EVENT_NAME,
    default_aggregation: { formula: 'sum' },
    customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
    value_settings: { event_payload_key: 'value' },
  })
}

/**
 * Find or create the Pro product and its two prices: a flat monthly base and
 * a metered price backed by the meter. The metered price is tiered so the
 * plan's included messages cost nothing and only the excess is charged —
 * that lets us report total usage and let Stripe apply the allowance.
 * Idempotent via lookup keys, so repeat calls reuse the same objects.
 */
async function proPrices(stripe: Awaited<ReturnType<typeof stripeClient>>) {
  const plan = PLANS.pro
  const baseLookup = `${PRO_PRODUCT_KEY}-base`
  const meteredLookup = `${PRO_PRODUCT_KEY}-messages`

  const existing = await stripe.prices.list({
    lookup_keys: [baseLookup, meteredLookup],
    limit: 10,
  })
  let base = existing.data.find((p) => p.lookup_key === baseLookup)
  let metered = existing.data.find((p) => p.lookup_key === meteredLookup)

  const products = await stripe.products.search({ query: `metadata['key']:'${PRO_PRODUCT_KEY}'` })
  let product = products.data[0]
  if (!product) {
    product = await stripe.products.create({
      name: 'MakerBay Trade',
      description: `Everything switched on: unlimited bookings, reviews and invoices, ${plan.includedMessages.toLocaleString()} assistant messages a month, custom domain.`,
      metadata: { key: PRO_PRODUCT_KEY },
    })
  } else if (product.name !== 'MakerBay Trade') {
    // The plan was renamed from "Assistant Pro" when pricing moved from
    // modules to tiers; keep the Stripe object in step.
    product = await stripe.products.update(product.id, {
      name: 'MakerBay Trade',
      description: `Everything switched on: unlimited bookings, reviews and invoices, ${plan.includedMessages.toLocaleString()} assistant messages a month, custom domain.`,
    })
  }

  if (!base) {
    base = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: plan.monthlyPriceCents,
      recurring: { interval: 'month' },
      lookup_key: baseLookup,
    })
  }
  if (!metered) {
    const meter = await assistantMeter(stripe)
    metered = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      billing_scheme: 'tiered',
      tiers_mode: 'graduated',
      tiers: [
        { up_to: plan.includedMessages, unit_amount: 0 },
        { up_to: 'inf', unit_amount: plan.overageCentsPerMessage },
      ],
      recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
      lookup_key: meteredLookup,
      nickname: 'Assistant messages',
    })
  }
  return { base, metered, product }
}

/**
 * Find or create the Genie product and its monthly base price. Genie is
 * Trade plus the copilot, so a Genie subscription carries this base and the
 * same metered assistant-messages price - one meter, one allowance,
 * whichever tier.
 */
async function geniePrices(stripe: Awaited<ReturnType<typeof stripeClient>>) {
  const plan = PLANS.genie
  const baseLookup = `${GENIE_PRODUCT_KEY}-base`
  const meteredLookup = `${GENIE_PRODUCT_KEY}-messages`
  const existing = await stripe.prices.list({ lookup_keys: [baseLookup, meteredLookup], limit: 10 })
  let base = existing.data.find((p) => p.lookup_key === baseLookup)
  let metered = existing.data.find((p) => p.lookup_key === meteredLookup)

  const products = await stripe.products.search({ query: `metadata['key']:'${GENIE_PRODUCT_KEY}'` })
  let product = products.data[0]
  if (!product) {
    product = await stripe.products.create({
      name: 'MakerBay Genie',
      description: 'Everything in Trade, plus Genie: your business run from a conversation - 2,500 Genie messages a month, actions behind your confirmation.',
      metadata: { key: GENIE_PRODUCT_KEY },
    })
  }
  if (!base) {
    base = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: plan.monthlyPriceCents,
      recurring: { interval: 'month' },
      lookup_key: baseLookup,
    })
  }
  // The metered assistant-messages price on the GENIE product (issue 56):
  // reusing Trade's metered price made checkout read "Genie and 1 more -
  // MakerBay Trade". Same meter, same allowance, right label.
  if (!metered) {
    const meter = await assistantMeter(stripe)
    metered = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      billing_scheme: 'tiered',
      tiers_mode: 'graduated',
      tiers: [
        { up_to: plan.includedMessages, unit_amount: 0 },
        { up_to: 'inf', unit_amount: plan.overageCentsPerMessage },
      ],
      recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
      lookup_key: meteredLookup,
      nickname: 'Assistant messages',
    })
  }
  return { base, metered, product }
}

/** The annual base: two months free, no metered item (see ANNUAL_PRICE_CENTS). */
async function annualPrice(
  stripe: Awaited<ReturnType<typeof stripeClient>>,
  productId: string,
) {
  const lookup = `${PRO_PRODUCT_KEY}-base-annual`
  const existing = await stripe.prices.list({ lookup_keys: [lookup], limit: 5 })
  if (existing.data[0]) return existing.data[0]
  return stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: ANNUAL_PRICE_CENTS,
    recurring: { interval: 'year' },
    lookup_key: lookup,
    nickname: 'Trade annual',
  })
}

// ── Founding members (issue 84) ─────────────────────────────────────────
// The first 100 workspaces pay $19/mo for Trade and keep that price for as
// long as they stay - the price rides their subscription, so "keep it" is
// simply how Stripe works. Seats are counted from live subscriptions on the
// founding price itself; when they are gone, checkout quietly uses the
// standard price.

const FOUNDING_LIMIT = 100
const FOUNDING_PRICE_CENTS = 1900

async function foundingPrice(
  stripe: Awaited<ReturnType<typeof stripeClient>>,
  productId: string,
) {
  const lookup = `${PRO_PRODUCT_KEY}-base-founding`
  const existing = await stripe.prices.list({ lookup_keys: [lookup], limit: 1 })
  if (existing.data[0]) return existing.data[0]
  return await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: FOUNDING_PRICE_CENTS,
    recurring: { interval: 'month' },
    lookup_key: lookup,
    nickname: 'Founding member',
  })
}

async function foundingSeatsLeft(
  stripe: Awaited<ReturnType<typeof stripeClient>>,
  priceId: string,
): Promise<number> {
  const subs = await stripe.subscriptions.list({ price: priceId, status: 'active', limit: 100 })
  return Math.max(0, FOUNDING_LIMIT - subs.data.length)
}

async function checkout(tenant: TenantLike, event: Event): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const interval: 'month' | 'year' = body.interval === 'year' ? 'year' : 'month'
  const wantGenie = body.plan === 'genie'
  const stripe = await stripeClient()
  // proPrices still creates the metered price; checkout no longer lists it,
  // and the webhook attaches it to the subscription instead.
  const { base, product } = await proPrices(stripe)

  let customerId = tenant.stripeCustomerId
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: tenant.name,
      metadata: { tenantId: tenant.tenantId },
    })
    customerId = customer.id
    await setTenantBilling(tenant.tenantId, { stripeCustomerId: customerId })
  }

  // Annual carries the base alone: Stripe cannot mix a yearly base with
  // monthly metering, and the honest alternative to overage is a pause at
  // the allowance, not a catch-up bill at renewal. Genie is month-to-month
  // for now - it is new, and nobody should prepay a year of it.
  let lineItems: Array<{ price: string; quantity?: number }>
  // Non-zero only when this checkout is actually getting the founding price.
  let foundingSeats = 0
  if (wantGenie) {
    // Base price only, so checkout reads "Subscribe to MakerBay Genie" with
    // no "and 1 more" (issue 56 follow-up). geniePrices still ensures the
    // metered price exists; the webhook attaches it to the subscription the
    // moment it is created, so usage metering is never missed.
    const genie = await geniePrices(stripe)
    lineItems = [{ price: genie.base.id, quantity: 1 }]
  } else if (interval === 'year') {
    lineItems = [{ price: (await annualPrice(stripe, product.id)).id, quantity: 1 }]
  } else {
    // Monthly Trade: founding price while seats last, standard after.
    let monthlyBase = base
    try {
      const founding = await foundingPrice(stripe, product.id)
      const left = await foundingSeatsLeft(stripe, founding.id)
      if (left > 0) {
        monthlyBase = founding
        foundingSeats = left
      }
    } catch (err) {
      console.warn('founding price unavailable, using standard', String(err))
    }
    // Base line only. Stripe labels each checkout line by its PRODUCT name,
    // not the price nickname, and the base and metered prices share a
    // product - so listing both read "MakerBay Trade and 1 more" with the
    // same name twice, which tells a customer nothing and looks like a
    // double charge. The metered item is attached by the webhook on the
    // subscription's first event, exactly as Genie has done since issue 56.
    lineItems = [{ price: monthlyBase.id, quantity: 1 }]
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: lineItems,
    client_reference_id: tenant.tenantId,
    subscription_data: { metadata: { tenantId: tenant.tenantId } },
    // A price that is quietly $10 less than the one advertised invites the
    // question "why?", and an unexplained discount reads as a trick rather
    // than an offer. Say what it is and that it lasts.
    ...(foundingSeats > 0
      ? {
          custom_text: {
            submit: {
              message:
                `Founding member price: $${(FOUNDING_PRICE_CENTS / 100).toFixed(0)} a month instead of `
                + `$${(PLANS.pro.monthlyPriceCents / 100).toFixed(0)}, and you keep it for as long as you stay. `
                + `${foundingSeats} of ${FOUNDING_LIMIT} places left.`,
            },
          },
        }
      : {}),
    success_url: `${process.env.APP_URL}/billing?upgraded=1`,
    cancel_url: `${process.env.APP_URL}/billing`,
  })
  return json(200, { url: session.url })
}

/**
 * Detach this workspace from Stripe and return it to the free plan.
 *
 * Local state only — it does NOT cancel anything at Stripe. Its purpose is
 * clearing stale linkage, most often test-mode ids left behind after a
 * switch to live keys. Because forgetting a live subscription would leave a
 * customer paying with nothing to show for it, an active subscription is
 * refused unless the caller explicitly forces it.
 */
async function reset(tenant: TenantLike, event: Event): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  const active = ['active', 'trialing', 'past_due'].includes(tenant.subscriptionStatus ?? '')
  if (active && body.force !== true) {
    return json(409, {
      error: 'subscription_active',
      message:
        'This workspace has a live subscription. Cancel it in the billing portal first, or pass force:true to detach anyway (Stripe keeps billing).',
      subscriptionStatus: tenant.subscriptionStatus,
    })
  }

  await clearTenantBilling(tenant.tenantId)
  const free = PLANS.free
  const entitlements = await getEntitlements(tenant.tenantId)
  for (const moduleId of Object.keys(entitlements.modules)) {
    await setModuleEntitlement(tenant.tenantId, moduleId, {
      enabled: entitlements.modules[moduleId].enabled,
      plan: free.id,
      limits: free.limits,
    })
  }
  console.log('billing reset', { tenantId: tenant.tenantId, forced: body.force === true })
  return json(200, { plan: free.id, modulesReset: Object.keys(entitlements.modules) })
}

async function portal(tenant: TenantLike): Promise<APIGatewayProxyResultV2> {
  if (!tenant.stripeCustomerId) return json(400, { error: 'no_customer' })
  const stripe = await stripeClient()
  const session = await stripe.billingPortal.sessions.create({
    customer: tenant.stripeCustomerId,
    return_url: `${process.env.APP_URL}/billing`,
  })
  return json(200, { url: session.url })
}
