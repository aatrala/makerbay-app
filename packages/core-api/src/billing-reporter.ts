import { getDayUsage, getEffectiveEntitlement, listBillableTenants } from '@makerbay/core'
import { METER_EVENT_NAME, stripeClient } from './stripe-client'

/**
 * Daily: report the previous day's assistant messages to the Stripe Billing
 * Meter. Meters aggregate by sum, so each run sends that day's delta — not a
 * running total. The identifier makes the event idempotent, so a retry or an
 * accidental second run on the same day cannot double-bill.
 *
 * Allowances are handled by the tiered metered price (included messages are
 * priced at zero), so we report total messages rather than computed overage.
 */
export const handler = async (event: { date?: string } = {}): Promise<{ reported: number; skipped: number }> => {
  let stripe
  try {
    stripe = await stripeClient()
  } catch {
    console.log('stripe not configured; nothing to report')
    return { reported: 0, skipped: 0 }
  }

  const day = event.date ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const tenants = await listBillableTenants()
  let reported = 0
  let skipped = 0

  for (const tenant of tenants) {
    const subscribed = ['active', 'trialing'].includes(tenant.subscriptionStatus ?? '')
    if (!subscribed || !tenant.stripeCustomerId) {
      skipped++
      continue
    }
    try {
      // A comped Pro tenant has no subscription item to bill against; metering
      // them would either error or bill a subscription that does not exist.
      const entitlement = await getEffectiveEntitlement(tenant.tenantId, 'assistant')
      if (entitlement.overage !== 'billed') {
        skipped++
        continue
      }
      const messages = await getDayUsage(tenant.tenantId, 'assistant', 'message', day)
      if (messages <= 0) {
        skipped++
        continue
      }
      await stripe.billing.meterEvents.create({
        event_name: METER_EVENT_NAME,
        identifier: `${tenant.tenantId}-${day}`,
        payload: {
          stripe_customer_id: tenant.stripeCustomerId,
          value: String(Math.round(messages)),
        },
      })
      reported++
      console.log('usage reported', { tenantId: tenant.tenantId, day, messages })
    } catch (err) {
      skipped++
      console.error('usage report failed', { tenantId: tenant.tenantId, day, err })
    }
  }
  console.log('reporting complete', { day, reported, skipped })
  return { reported, skipped }
}
