import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Per-tenant address status. The reason this is not the provider's own
 * suppression list: that list is account-wide, so one tenant's bounce would
 * silence that address for every other tenant, and two plumbers sharing a
 * customer is not hypothetical.
 */

let store: Map<string, Record<string, unknown>>
const updates: Array<Record<string, unknown>> = []

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }))
vi.mock('@aws-sdk/client-eventbridge', () => ({ EventBridgeClient: class {}, PutEventsCommand: class {} }))
vi.mock('@aws-sdk/client-sesv2', () => ({ SESv2Client: class {}, SendEmailCommand: class {} }))
vi.mock('@aws-sdk/client-pinpoint-sms-voice-v2', () => ({
  PinpointSMSVoiceV2Client: class {}, SendTextMessageCommand: class {},
}))
vi.mock('@aws-sdk/lib-dynamodb', () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  const id = (k: Record<string, string>) => `${k.tenantId}|${k.messageId}`
  return {
    DynamoDBDocumentClient: { from: () => ({
      send: async (c: Cmd & { _k: string }) => {
        if (c._k === 'put') {
          const it = c.input.Item as Record<string, unknown>
          const prev = store.get(id(it as never))
          const cond = c.input.ConditionExpression as string | undefined
          // Mirror the real conditional write, or the ordering test proves
          // nothing about what DynamoDB would actually do.
          if (cond?.includes('#rank') && prev !== undefined) {
            const want = (c.input.ExpressionAttributeValues as Record<string, number>)[':rank']
            if (Number(prev.rank ?? 0) > want) {
              const e = new Error('conditional') as Error & { name: string }
              e.name = 'ConditionalCheckFailedException'
              throw e
            }
          }
          store.set(id(it as never), it as Record<string, unknown>)
          return {}
        }
        if (c._k === 'update') {
          updates.push(c.input)
          const k = c.input.Key as Record<string, string>
          const v = c.input.ExpressionAttributeValues as Record<string, unknown>
          store.set(id(k), { ...(store.get(id(k)) ?? {}), state: v[':s'], reason: v[':r'] })
          return {}
        }
        if (c._k === 'get') return { Item: store.get(id(c.input.Key as Record<string, string>)) }
        return { Items: [] }
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

const { emailBlocked, recordMailEvent, setEmailStatus } = await import('./maillog')

describe('emailBlocked', () => {
  beforeEach(() => {
    store = new Map()
    updates.length = 0
    process.env.TABLE_MAILLOG = 'makerbay-maillog'
  })

  it('lets an unknown address through', async () => {
    expect(await emailBlocked('T1', 'new@example.com', false)).toBe(false)
  })

  it('stops everything to an address that hard-bounced', async () => {
    await setEmailStatus('T1', 'dead@example.com', 'bounced')
    expect(await emailBlocked('T1', 'dead@example.com', false)).toBe('bounced')
    expect(await emailBlocked('T1', 'dead@example.com', true)).toBe('bounced')
  })

  // The distinction that keeps the product working. Someone who reported a
  // review request as spam has still asked for a quote, and refusing to send
  // it would break the product to respect a preference they never expressed.
  it('stops only optional mail after a complaint', async () => {
    await setEmailStatus('T1', 'cross@example.com', 'complained')
    expect(await emailBlocked('T1', 'cross@example.com', true)).toBe('complained')
    expect(await emailBlocked('T1', 'cross@example.com', false)).toBe(false)
  })

  it('is scoped per tenant, so one business cannot silence another', async () => {
    await setEmailStatus('T1', 'shared@example.com', 'bounced')
    expect(await emailBlocked('T1', 'shared@example.com', false)).toBe('bounced')
    expect(await emailBlocked('T2', 'shared@example.com', false)).toBe(false)
  })

  it('matches an address whatever the case or spacing', async () => {
    await setEmailStatus('T1', 'Dead@Example.com', 'bounced')
    expect(await emailBlocked('T1', '  dead@example.com ', false)).toBe('bounced')
  })

  it('ignores anything that is not an address', async () => {
    expect(await emailBlocked('T1', '', false)).toBe(false)
    expect(await emailBlocked('T1', 'not-an-address', false)).toBe(false)
  })

  // A status we cannot read must never become a send we refuse: losing a
  // booking confirmation is worse than one wasted send.
  it('fails open when the table cannot be read', async () => {
    delete process.env.TABLE_MAILLOG
    expect(await emailBlocked('T1', 'someone@example.com', false)).toBe(false)
    process.env.TABLE_MAILLOG = 'makerbay-maillog'
  })
})

/**
 * A mocked DynamoDB client accepts any expression, so the first version of
 * setEmailStatus passed every unit test here and then threw
 * ValidationException in production: `at` is a reserved keyword. This asserts
 * the shape a mock cannot enforce.
 *
 * Not the full ~570-word reserved list - just the names this module actually
 * writes, which is what a regression needs to cover.
 */
describe('setEmailStatus expression', () => {
  beforeEach(() => {
    store = new Map()
    updates.length = 0
    process.env.TABLE_MAILLOG = 'makerbay-maillog'
  })

  const RESERVED = ['at', 'state', 'status', 'name', 'timestamp', 'value', 'data']

  it('aliases every attribute name, so no reserved keyword reaches DynamoDB', async () => {
    await setEmailStatus('T1', 'x@example.com', 'bounced', 'General')
    const expr = String(updates[0].UpdateExpression)
    // Everything on the left of an `=` must be a `#alias`, never a bare name.
    for (const lhs of expr.replace(/^SET /, '').split(',').map((p) => p.split('=')[0].trim())) {
      expect(lhs.startsWith('#'), `${lhs} in "${expr}"`).toBe(true)
    }
    for (const word of RESERVED) {
      expect(new RegExp(`(^|[\s,])${word}\s*=`, 'i').test(expr), `${word} unaliased`).toBe(false)
    }
  })

  it('declares a name for every alias it uses', async () => {
    await setEmailStatus('T1', 'x@example.com', 'bounced')
    const expr = String(updates[0].UpdateExpression)
    const names = updates[0].ExpressionAttributeNames as Record<string, string>
    for (const alias of expr.match(/#[A-Za-z0-9_]+/g) ?? []) {
      expect(names[alias], `${alias} undeclared`).toBeDefined()
    }
  })
})

/**
 * One row per message, so ordering matters. SES sends Delivery and THEN
 * Complaint for the same message and EventBridge does not promise order, so
 * an unconditional write loses whichever arrives first.
 */
describe('recordMailEvent ordering', () => {
  beforeEach(() => {
    store = new Map()
    updates.length = 0
    process.env.TABLE_MAILLOG = 'makerbay-maillog'
  })

  const ev = (state: string) => ({
    tenantId: 'T1', messageId: 'M1', state, to: 'x@example.com',
    audience: 'customer', at: '2026-08-28T00:00:00.000Z',
  }) as never

  const stateOf = () => store.get('T1|M1')?.state

  it('records the first event', async () => {
    await recordMailEvent(ev('delivered'))
    expect(stateOf()).toBe('delivered')
  })

  // The exact sequence the mailbox simulator produces.
  it('lets a complaint replace a delivery', async () => {
    await recordMailEvent(ev('delivered'))
    await recordMailEvent(ev('complained'))
    expect(stateOf()).toBe('complained')
  })

  // The bug: the delivery event landing second wiped the complaint.
  it('does NOT let a late delivery erase a complaint', async () => {
    await recordMailEvent(ev('complained'))
    await recordMailEvent(ev('delivered'))
    expect(stateOf()).toBe('complained')
  })

  it('does not let a late delivery erase a bounce', async () => {
    await recordMailEvent(ev('bounced'))
    await recordMailEvent(ev('delivered'))
    expect(stateOf()).toBe('bounced')
  })

  // A message that was slow and then arrived reads as arrived.
  it('lets a delivery replace a delay', async () => {
    await recordMailEvent(ev('delayed'))
    await recordMailEvent(ev('delivered'))
    expect(stateOf()).toBe('delivered')
  })

  it('never lets the initial send overwrite anything', async () => {
    await recordMailEvent(ev('bounced'))
    await recordMailEvent(ev('sent'))
    expect(stateOf()).toBe('bounced')
  })

  it('keeps separate messages separate', async () => {
    await recordMailEvent(ev('bounced'))
    await recordMailEvent({ ...(ev('delivered') as object), messageId: 'M2' } as never)
    expect(stateOf()).toBe('bounced')
    expect(store.get('T1|M2')?.state).toBe('delivered')
  })
})
