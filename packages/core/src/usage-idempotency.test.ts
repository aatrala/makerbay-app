import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The bug this guards: EventBridge delivers at least once, `ADD quantity` is
 * not idempotent, and this counter is both the plan-limit check and the value
 * reported to Stripe as metered usage. A redelivered event used to overbill.
 */

const sent: Array<{ kind: string; input: Record<string, unknown> }> = []
let claimed: Set<string>

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }))
vi.mock('@aws-sdk/lib-dynamodb', () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    DynamoDBDocumentClient: { from: () => ({
      send: async (c: Cmd & { _k: string }) => {
        sent.push({ kind: c._k, input: c.input })
        if (c._k === 'put' && c.input.ConditionExpression) {
          // DynamoDB keys on (pk, sk) together. The markers are partitioned
          // per tenant, so two tenants may legitimately share a key.
          const item = c.input.Item as Record<string, unknown>
          const key = `${item.pk}|${item.sk}`
          if (claimed.has(key)) {
            const e = new Error('exists') as Error & { name: string }
            e.name = 'ConditionalCheckFailedException'
            throw e
          }
          claimed.add(key)
        }
        return {}
      },
    }) },
    PutCommand: class extends Cmd { _k = 'put' },
    UpdateCommand: class extends Cmd { _k = 'update' },
    GetCommand: class extends Cmd { _k = 'get' },
    QueryCommand: class extends Cmd { _k = 'query' },
    ScanCommand: class extends Cmd { _k = 'scan' },
    DeleteCommand: class extends Cmd { _k = 'delete' },
  }
})

const { addUsage } = await import('./db')

const adds = () => sent.filter((s) => s.kind === 'update')

describe('addUsage idempotency', () => {
  beforeEach(() => {
    sent.length = 0
    claimed = new Set()
    process.env.TABLE_USAGE = 'makerbay-usage'
  })

  it('counts a redelivered event exactly once', async () => {
    await addUsage('T1', 'assistant', 'message', 1, '2026-08-27', 'evt-1')
    await addUsage('T1', 'assistant', 'message', 1, '2026-08-27', 'evt-1')
    expect(adds()).toHaveLength(1)
  })

  it('still counts genuinely distinct events', async () => {
    await addUsage('T1', 'assistant', 'message', 1, '2026-08-27', 'evt-1')
    await addUsage('T1', 'assistant', 'message', 1, '2026-08-27', 'evt-2')
    expect(adds()).toHaveLength(2)
  })

  it('does not dedupe across tenants sharing a key', async () => {
    await addUsage('T1', 'assistant', 'message', 1, '2026-08-27', 'evt-1')
    await addUsage('T2', 'assistant', 'message', 1, '2026-08-27', 'evt-1')
    expect(adds()).toHaveLength(2)
  })

  it('keeps counting when no key is supplied', async () => {
    await addUsage('T1', 'assistant', 'message', 1, '2026-08-27')
    await addUsage('T1', 'assistant', 'message', 1, '2026-08-27')
    expect(adds()).toHaveLength(2)
  })

  it('keeps the marker off the counter partition, so getMonthUsage never sums it', async () => {
    await addUsage('T1', 'assistant', 'message', 1, '2026-08-27', 'evt-1')
    const marker = sent.find((s) => s.kind === 'put')!.input.Item as Record<string, unknown>
    const counter = adds()[0].input.Key as Record<string, unknown>
    expect(marker.pk).not.toBe(counter.pk)
    expect(marker.expiresAt).toBeTypeOf('number')
  })
})
