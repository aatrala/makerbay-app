import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import type Stripe from 'stripe'
import { setModuleEntitlement, setTenantBilling } from '@makerbay/core'
import { PLANS, stripeClient, webhookSecret } from './stripe-client'

/**
 * Stripe subscription lifecycle. The request is authenticated by its
 * signature over the raw body — never parse before verifying.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const signature = event.headers['stripe-signature'] ?? event.headers['Stripe-Signature']
  if (!signature || !event.body) return { statusCode: 400, body: 'missing_signature' }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body

  let stripeEvent: Stripe.Event
  try {
    const stripe = await stripeClient()
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, await webhookSecret())
  } catch (err) {
    console.warn('webhook signature rejected', String(err))
    return { statusCode: 400, body: 'invalid_signature' }
  }

  try {
    switch (stripeEvent.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object as Stripe.Subscription
        const tenantId = sub.metadata?.tenantId
        if (!tenantId) {
          console.warn('subscription without tenantId', sub.id)
          break
        }
        // Only an active or trialing subscription grants Pro.
        const entitled = ['active', 'trialing'].includes(sub.status)
        const plan = entitled ? PLANS.pro : PLANS.free
        const item = sub.items?.data.find((i) => i.price?.recurring?.usage_type === 'metered')
        const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end

        await setTenantBilling(tenantId, {
          plan: plan.id,
          stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
          stripeSubscriptionId: sub.id,
          stripeMeteredItemId: item?.id,
          subscriptionStatus: sub.status,
          currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : undefined,
        })
        await setModuleEntitlement(tenantId, 'assistant', {
          enabled: true,
          plan: plan.id,
          limits: plan.limits,
        })
        console.log('subscription applied', { tenantId, plan: plan.id, status: sub.status })
        break
      }
      default:
        // Everything else is acknowledged and ignored on purpose.
        break
    }
  } catch (err) {
    console.error('webhook handling failed', { type: stripeEvent.type, err })
    // 500 tells Stripe to retry — the event is not lost.
    return { statusCode: 500, body: 'handler_error' }
  }

  return { statusCode: 200, body: 'ok' }
}
