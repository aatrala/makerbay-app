import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unsubscribe (issue 121).
 *
 * Until this, the only way a homeowner could stop a review request was the
 * spam button - the most damaging deliverability signal there is, on a domain
 * shared by every tenant.
 */

let store: Map<string, Record<string, unknown>>

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
        const i = c.input
        if (c._k === 'put') {
          const it = i.Item as Record<string, string>
          store.set(id(it as never), { ...it })
          return {}
        }
        if (c._k === 'update') {
          const k = i.Key as Record<string, string>
          const v = i.ExpressionAttributeValues as Record<string, unknown>
          store.set(id(k), { ...(store.get(id(k)) ?? {}), state: v[':s'], reason: v[':r'] })
          return {}
        }
        if (c._k === 'get') return { Item: store.get(id(i.Key as Record<string, string>)) }
        return { Items: [] }
      },
    }) },
    PutCommand: class extends Cmd { _k = 'put' },
    UpdateCommand: class extends Cmd { _k = 'update' },
    GetCommand: class extends Cmd { _k = 'get' },
    QueryCommand: class extends Cmd { _k = 'query' },
    DeleteCommand: class extends Cmd { _k = 'delete' },
    ScanCommand: class extends Cmd { _k = 'scan' },
  }
})

const { applyUnsubscribe, resolveUnsub, unsubTokenFor, unsubUrl } = await import('./unsubscribe')
const { emailBlocked } = await import('./maillog')

beforeEach(() => {
  store = new Map()
  process.env.TABLE_MAILLOG = 'makerbay-maillog'
})

describe('unsubTokenFor', () => {
  it('issues a token for an address', async () => {
    const t = await unsubTokenFor('T1', 'marie@example.com')
    expect(t).toMatch(/^[A-Za-z0-9_-]{20,40}$/)
  })

  /**
   * Stable on purpose. A customer who unsubscribes from a link in a
   * three-month-old email must still be unsubscribed, and a token that rotated
   * per message would leave every previously sent link dead.
   */
  it('reuses the same token for the same address', async () => {
    const a = await unsubTokenFor('T1', 'marie@example.com')
    const b = await unsubTokenFor('T1', 'marie@example.com')
    expect(a).toBe(b)
  })

  it('ignores casing and spacing, so one person gets one token', async () => {
    const a = await unsubTokenFor('T1', 'Marie@Example.com')
    const b = await unsubTokenFor('T1', '  marie@example.com ')
    expect(a).toBe(b)
  })

  // Two tradespeople can share a customer. Unsubscribing from one must not be
  // the same act as unsubscribing from the other.
  it('gives a different token per tenant for the same person', async () => {
    const a = await unsubTokenFor('T1', 'marie@example.com')
    const b = await unsubTokenFor('T2', 'marie@example.com')
    expect(a).not.toBe(b)
  })

  it('gives nothing for something that is not an address', async () => {
    expect(await unsubTokenFor('T1', '')).toBeUndefined()
    expect(await unsubTokenFor('T1', 'not-an-address')).toBeUndefined()
  })
})

describe('resolveUnsub', () => {
  it('finds who a token belongs to', async () => {
    const t = await unsubTokenFor('T1', 'marie@example.com')
    expect(await resolveUnsub(t!)).toEqual({ tenantId: 'T1', email: 'marie@example.com' })
  })

  // A guessed token must not become a database read, and must never confirm
  // that an address exists.
  it('refuses anything not shaped like one of ours', async () => {
    expect(await resolveUnsub('short')).toBeUndefined()
    expect(await resolveUnsub('')).toBeUndefined()
    expect(await resolveUnsub('../../etc/passwd')).toBeUndefined()
    expect(await resolveUnsub('x'.repeat(200))).toBeUndefined()
  })

  it('gives nothing for a well-shaped token we never issued', async () => {
    expect(await resolveUnsub('A'.repeat(24))).toBeUndefined()
  })
})

describe('the effect of unsubscribing', () => {
  /**
   * The distinction the whole feature turns on. Someone who unsubscribed from
   * review requests is still owed the invoice for the work, and withholding it
   * would be the wrong reading of what they asked for.
   */
  it('stops the mail they objected to and nothing else', async () => {
    await applyUnsubscribe({ tenantId: 'T1', email: 'marie@example.com' })
    expect(await emailBlocked('T1', 'marie@example.com', true)).toBe('unsubscribed')
    expect(await emailBlocked('T1', 'marie@example.com', false)).toBe(false)
  })

  it('does not touch the same person at a different business', async () => {
    await applyUnsubscribe({ tenantId: 'T1', email: 'marie@example.com' })
    expect(await emailBlocked('T2', 'marie@example.com', true)).toBe(false)
  })

  it('is idempotent, because mail clients retry', async () => {
    await applyUnsubscribe({ tenantId: 'T1', email: 'marie@example.com' })
    await applyUnsubscribe({ tenantId: 'T1', email: 'marie@example.com' })
    expect(await emailBlocked('T1', 'marie@example.com', true)).toBe('unsubscribed')
  })

  it('still resolves the token afterwards, so a second click is not an error', async () => {
    const t = await unsubTokenFor('T1', 'marie@example.com')
    await applyUnsubscribe({ tenantId: 'T1', email: 'marie@example.com' })
    expect(await resolveUnsub(t!)).toBeDefined()
  })
})

describe('unsubUrl', () => {
  it('is a plain https address a mail client can POST to', () => {
    const u = unsubUrl('abc123')
    expect(u.startsWith('https://')).toBe(true)
    expect(u).toContain('t=abc123')
  })

  it('encodes the token rather than pasting it in raw', () => {
    expect(unsubUrl('a b&c')).toContain('t=a%20b%26c')
  })
})
