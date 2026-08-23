import { getMonthUsage, listBillableTenants } from '@makerbay/core'
import { PLANS, stripeClient } from './stripe-client'

/**
 * Daily: report month-to-date overage to Stripe for every subscribed
 * tenant. Uses `action: 'set'` so a re-run overwrites rather than
 * double-charges — the job is safe to retry.
 */
export const handler = async (): Promise<{ reported: number; skipped: number }> => {
  let stripe
  try {
    stripe = await stripeClient()
  } catch {
    console.log('stripe not configured; nothing to report')
    return { reported: 0, skipped: 0 }
  }

  const month = new Date().toISOString().slice(0, 7)
  const tenants = await listBillableTenants()
  let reported = 0
  let skipped = 0

  for (const tenant of tenants) {
    if (!tenant.stripeMeteredItemId || !['active', 'trialing'].includes(tenant.subscriptionStatus ?? '')) {
      skipped++
      continue
    }
    try {
      const totals = await getMonthUsage(tenant.tenantId, month)
      const messages = totals['assistant.message'] ?? 0
      const included = (PLANS[tenant.plan] ?? PLANS.pro).includedMessages
      const overage = Math.max(0, Math.round(messages - included))

      await stripe.subscriptionItems.createUsageRecord(tenant.stripeMeteredItemId, {
        quantity: overage,
        timestamp: 'now',
        action: 'set',
      })
      reported++
      console.log('usage reported', { tenantId: tenant.tenantId, messages, overage })
    } catch (err) {
      skipped++
      console.error('usage report failed', { tenantId: tenant.tenantId, err })
    }
  }
  return { reported, skipped }
}
