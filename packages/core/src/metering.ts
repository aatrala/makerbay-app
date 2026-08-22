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
