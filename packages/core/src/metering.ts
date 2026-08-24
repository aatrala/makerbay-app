import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import { ulid } from './ids'

const eb = new EventBridgeClient({})

export interface UsageEvent {
  tenantId: string
  moduleId: string
  metric: string
  quantity: number
  idempotencyKey?: string
}

/**
 * Emit a domain event to the makerbay bus - the module-to-module contract.
 * A module that reacts to another module's moment (a booking completing, an
 * invoice being paid) listens for these rather than being called directly,
 * so switching one module off never breaks another.
 */
export async function emitEvent(
  moduleId: string,
  detailType: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: process.env.EVENT_BUS ?? 'makerbay',
          Source: `makerbay.${moduleId}`,
          DetailType: detailType,
          Detail: JSON.stringify({ ...detail, ts: new Date().toISOString() }),
        },
      ],
    }),
  )
}

/** Emit a usage event to the makerbay bus. Schema is a stable contract. */
export async function emitUsage(event: UsageEvent): Promise<void> {
  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: process.env.EVENT_BUS ?? 'makerbay',
          Source: `makerbay.${event.moduleId}`,
          DetailType: 'usage',
          Detail: JSON.stringify({
            ...event,
            idempotencyKey: event.idempotencyKey ?? ulid(),
            ts: new Date().toISOString(),
          }),
        },
      ],
    }),
  )
}
