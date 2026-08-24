import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import type Stripe from 'stripe'
import { emitEvent, putStripeGrant, setModuleEntitlement, setTenantBilling } from '@makerbay/core'
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
          lastWebhookAt: new Date(stripeEvent.created * 1000).toISOString(),
          lastWebhookType: stripeEvent.type,
          lastWebhookLive: stripeEvent.livemode,
        })
        // Keep the module switched on, then write only the Stripe grant.
        // Manual comps live under different sort keys and are untouched.
        await setModuleEntitlement(tenantId, 'assistant', {
          enabled: true,
          plan: plan.id,
          limits: plan.limits,
        })
        try {
          await putStripeGrant({
            tenantId,
            moduleId: 'assistant',
            planTier: plan.id,
            limits: plan.limits,
            active: entitled,
            stripeSubscriptionId: sub.id,
            stripeEventCreated: stripeEvent.created,
          })
        } catch (err) {
          // Condition failure means a newer event already landed. Stripe does
          // not guarantee ordering, so this is expected, not an error.
          if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err
          console.log('skipped out-of-order subscription event', { tenantId, id: sub.id })
        }
        console.log('subscription applied', { tenantId, plan: plan.id, status: sub.status })
        break
      }
      // Connect payments. Signature is verified above; the payments module
      // owns fulfilment, reached over the bus like every module-to-module
      // hop. The forwarded detail is the Stripe object itself.
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object as Stripe.Checkout.Session
        await emitEvent('stripe', 'stripe.checkout.completed', {
          id: session.id,
          payment_intent: session.payment_intent,
          metadata: session.metadata ?? {},
          amount_total: session.amount_total,
          currency: session.currency,
        })
        break
      }
      case 'account.updated': {
        const account = stripeEvent.data.object as Stripe.Account
        await emitEvent('stripe', 'stripe.account.updated', {
          id: account.id,
          metadata: account.metadata ?? {},
          payouts_enabled: account.payouts_enabled,
          charges_enabled: account.charges_enabled,
          details_submitted: account.details_submitted,
        })
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
