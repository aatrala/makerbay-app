import { addUsage } from '@makerbay/core'

interface UsageDetail {
  tenantId: string
  moduleId: string
  metric: string
  quantity: number
  idempotencyKey: string
  ts: string
}

// EventBridge target: folds usage events into daily counters in the Usage
// table. This table is the source for plan-limit checks, the dashboard
// usage screen, and (later) Stripe metered billing reporting.
export const handler = async (event: { detail: UsageDetail }): Promise<void> => {
  const d = event.detail
  if (!d?.tenantId || !d.moduleId || !d.metric || !Number.isFinite(d.quantity)) {
    console.error('malformed usage event', d)
    return
  }
  const date = (d.ts ?? new Date().toISOString()).slice(0, 10)
  await addUsage(d.tenantId, d.moduleId, d.metric, d.quantity, date)
}
