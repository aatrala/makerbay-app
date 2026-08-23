import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import {
  getMonthUsage,
  getTenant,
  getUser,
  setTenantBilling,
  type CallerContext,
} from '@makerbay/core'
import { isTestMode, PLANS, PRO_PRODUCT_KEY, stripeClient } from './stripe-client'

type Event = APIGatewayProxyEventV2WithLambdaAuthorizer<CallerContext>

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

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
    if (method === 'POST' && path === '/v1/core/billing/checkout') return await checkout(tenant)
    if (method === 'POST' && path === '/v1/core/billing/portal') return await portal(tenant)
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
}

async function summary(tenant: TenantLike): Promise<APIGatewayProxyResultV2> {
  const plan = PLANS[tenant.plan] ?? PLANS.free
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
    billingConfigured,
    testMode: billingConfigured ? await isTestMode() : null,
  })
}

/**
 * Find or create the Pro product and its two prices (flat base + metered
 * overage). Idempotent via a lookup key, so repeat calls reuse the same
 * price objects rather than cluttering the Stripe account.
 */
async function proPrices(stripe: Awaited<ReturnType<typeof stripeClient>>) {
  const plan = PLANS.pro
  const baseLookup = `${PRO_PRODUCT_KEY}-base`
  const meteredLookup = `${PRO_PRODUCT_KEY}-messages`

  const existing = await stripe.prices.list({
    lookup_keys: [baseLookup, meteredLookup],
    expand: ['data.product'],
    limit: 10,
  })
  let base = existing.data.find((p) => p.lookup_key === baseLookup)
  let metered = existing.data.find((p) => p.lookup_key === meteredLookup)
  if (base && metered) return { base, metered }

  const products = await stripe.products.search({ query: `metadata['key']:'${PRO_PRODUCT_KEY}'` })
  const product =
    products.data[0] ??
    (await stripe.products.create({
      name: 'MakerBay Assistant Pro',
      description: `Includes ${plan.includedMessages.toLocaleString()} assistant messages per month`,
      metadata: { key: PRO_PRODUCT_KEY },
    }))

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
    metered = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: plan.overageCentsPerMessage,
      recurring: { interval: 'month', usage_type: 'metered', aggregate_usage: 'sum' },
      lookup_key: meteredLookup,
      nickname: 'Additional messages',
    })
  }
  return { base, metered }
}

async function checkout(tenant: TenantLike): Promise<APIGatewayProxyResultV2> {
  const stripe = await stripeClient()
  const { base, metered } = await proPrices(stripe)

  let customerId = tenant.stripeCustomerId
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: tenant.name,
      metadata: { tenantId: tenant.tenantId },
    })
    customerId = customer.id
    await setTenantBilling(tenant.tenantId, { stripeCustomerId: customerId })
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: base.id, quantity: 1 }, { price: metered.id }],
    client_reference_id: tenant.tenantId,
    subscription_data: { metadata: { tenantId: tenant.tenantId } },
    success_url: `${process.env.APP_URL}/billing?upgraded=1`,
    cancel_url: `${process.env.APP_URL}/billing`,
  })
  return json(200, { url: session.url })
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
