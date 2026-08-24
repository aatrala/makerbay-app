import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, ulid } from '@makerbay/core'

/**
 * The one writer of the audit table. Two inputs, one shape:
 *
 * 1. `audit` events - explicit recordAudit() calls from module code.
 * 2. Existing `usage` events - the metering stream already narrates most of
 *    the business ("quote.sent", "payment.received"), so the trail reaches
 *    back over everything instrumented today without touching any module.
 *    Metrics that are volume, not story (assistant messages, ingest bytes),
 *    are skipped by not appearing in the sentence map.
 *
 * Partitioned tenantId#yyyy-mm like Usage, TTL ~13 months.
 */

const TABLE = () => process.env.TABLE_AUDIT!
const RETENTION_DAYS = 400

interface BusEvent {
  'detail-type': string
  source?: string
  detail: Record<string, unknown>
}

/** Usage metrics worth a feed line, as owner-readable sentences. */
const METRIC_SENTENCES: Record<string, (d: Record<string, unknown>) => string> = {
  'booking.created': () => 'A customer booked online',
  'reminder.sent': () => 'A booking reminder email went out',
  'quote.sent': () => 'A quote was sent',
  'quote.accepted': () => 'A customer accepted a quote',
  'invoice.sent': () => 'An invoice was sent',
  'invoice.paid': () => 'An invoice was marked paid',
  'payment.received': () => 'A card payment arrived',
  'payment.refunded': () => 'A payment was refunded',
  'review.requested': () => 'A review ask went out',
  'review.published': () => 'A customer left a review',
  'missedcall.rescued': () => 'A missed call was rescued by text',
  'rescue.booked': () => 'A rescued caller booked a job',
  'handoff.created': () => 'A conversation was handed to you',
  'lead.captured': () => 'A new lead arrived',
}

export const handler = async (event: BusEvent): Promise<void> => {
  const type = event['detail-type']
  const d = event.detail ?? {}
  const tenantId = String(d.tenantId ?? '')
  if (!tenantId) return

  let item: Record<string, unknown> | undefined
  const ts = String(d.ts ?? new Date().toISOString())
  const moduleId = String(event.source ?? '').replace(/^makerbay\./, '') || 'platform'

  if (type === 'audit') {
    item = {
      actor: d.actor ?? { type: 'system', id: moduleId },
      origin: d.origin ?? 'automation',
      action: d.action,
      moduleId: d.moduleId ?? moduleId,
      targetId: d.targetId,
      summary: d.summary,
    }
  } else if (type === 'usage') {
    const sentence = METRIC_SENTENCES[String(d.metric ?? '')]
    if (!sentence) return
    item = {
      actor: { type: 'system', id: moduleId, label: 'MakerBay' },
      origin: 'automation',
      action: String(d.metric),
      moduleId,
      summary: sentence(d),
    }
  } else {
    return
  }

  await ddb.send(
    new PutCommand({
      TableName: TABLE(),
      Item: {
        pk: `${tenantId}#${ts.slice(0, 7)}`,
        sk: `${ts}#${String(d.id ?? ulid())}`,
        tenantId,
        ts,
        ...item,
        expiresAt: Math.floor(Date.now() / 1000) + RETENTION_DAYS * 86_400,
      },
    }),
  )
}
