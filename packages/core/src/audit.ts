import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import { ulid } from './ids'

const eb = new EventBridgeClient({})

/**
 * The workspace activity trail: who did what, when, in one sentence a
 * business owner can read. Entries travel the bus (detail-type `audit`) and
 * one writer Lambda lands them in the audit table - modules never write the
 * table directly, so retention and shape live in exactly one place.
 *
 * This is the tenant-facing activity feed and, later, Genie's memory of what
 * happened. The staff console's append-only AdminAudit remains the separate
 * compliance record for staff actions.
 */

export interface AuditActor {
  type: 'user' | 'apikey' | 'genie' | 'system'
  /** userId / keyId / 'genie' / the emitting module. */
  id: string
  /** How the feed names them: an email, a key label, 'Genie', 'MakerBay'. */
  label?: string
}

export interface AuditEntry {
  tenantId: string
  actor: AuditActor
  origin: 'ui' | 'api' | 'genie' | 'automation'
  /** Dotted verb, e.g. 'quotes.sent', 'workspace.slug_changed'. */
  action: string
  moduleId: string
  targetId?: string
  /** One human sentence. The feed shows this verbatim. */
  summary: string
}

/** Fire-and-forget: activity must never fail the action it describes. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await eb.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: process.env.EVENT_BUS ?? 'makerbay',
            Source: `makerbay.${entry.moduleId}`,
            DetailType: 'audit',
            Detail: JSON.stringify({ ...entry, id: ulid(), ts: new Date().toISOString() }),
          },
        ],
      }),
    )
  } catch (err) {
    console.warn('audit emit failed', { action: entry.action, err: String(err) })
  }
}
