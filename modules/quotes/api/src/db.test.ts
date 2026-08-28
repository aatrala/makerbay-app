import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * View counting must not be able to destroy an acceptance (issue 119 review).
 *
 * The first version read the whole quote, incremented a counter and wrote the
 * whole row back with an unconditional Put. Two requests reading before either
 * wrote meant the second restored every field the first had changed - so a
 * view landing just after an acceptance reverted `status` to `sent` and erased
 * the signed acceptance record.
 *
 * The mock below is a real last-write-wins store, so a read-modify-write can
 * genuinely lose an update in it. That is what makes these tests meaningful
 * rather than a restatement of the implementation.
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
  const id = (k: Record<string, string>) => `${k.tenantId}|${k.quoteId}`
  return {
    DynamoDBDocumentClient: { from: () => ({
      send: async (c: Cmd & { _k: string }) => {
        const i = c.input
        if (c._k === 'put') {
          const item = i.Item as Record<string, string>
          store.set(id(item as never), { ...item })
          return {}
        }
        if (c._k === 'update') {
          const key = i.Key as Record<string, string>
          const prev = store.get(id(key))
          if (String(i.ConditionExpression ?? '').includes('attribute_exists') && !prev) {
            const e = new Error('cond') as Error & { name: string }
            e.name = 'ConditionalCheckFailedException'
            throw e
          }
          const v = i.ExpressionAttributeValues as Record<string, unknown>
          // Only the named attributes move, which is the whole point.
          const next = { ...(prev ?? {}) }
          next.viewCount = Number(next.viewCount ?? 0) + Number(v[':one'])
          next.lastViewedAt = v[':at']
          next.firstViewedAt = next.firstViewedAt ?? v[':at']
          store.set(id(key), next)
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

const { countQuoteView, getQuote, putQuote } = await import('./db')

const quote = (over: Record<string, unknown> = {}) =>
  ({
    tenantId: 'T1', quoteId: 'Q1', number: 8, contactId: 'C1',
    lines: [], subtotalCents: 0, taxRate: 0, taxCents: 0, totalCents: 33500,
    currency: 'AUD', status: 'sent', publicToken: 'tok',
    validUntil: '2026-09-27T00:00:00.000Z',
    createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
    ...over,
  }) as never

beforeEach(() => {
  store = new Map()
  process.env.TABLE_QUOTES = 'makerbay-quotes'
})

describe('countQuoteView', () => {
  it('counts a view', async () => {
    await putQuote(quote())
    await countQuoteView('T1', 'Q1', '2026-08-28T10:00:00.000Z')
    const q = await getQuote('T1', 'Q1')
    expect(q?.viewCount).toBe(1)
    expect(q?.firstViewedAt).toBe('2026-08-28T10:00:00.000Z')
  })

  it('keeps the first view first and moves the last', async () => {
    await putQuote(quote())
    await countQuoteView('T1', 'Q1', '2026-08-28T10:00:00.000Z')
    await countQuoteView('T1', 'Q1', '2026-08-28T11:00:00.000Z')
    const q = await getQuote('T1', 'Q1')
    expect(q?.viewCount).toBe(2)
    expect(q?.firstViewedAt).toBe('2026-08-28T10:00:00.000Z')
    expect(q?.lastViewedAt).toBe('2026-08-28T11:00:00.000Z')
  })

  /**
   * The bug, reproduced as the sequence that caused it.
   *
   * The old recordView took the quote object the HANDLER had already read at
   * the start of the request and wrote that whole object back - so the stale
   * copy was the argument. This does the same thing by hand to show the
   * damage, then shows the current API cannot express it: it takes ids and
   * touches three attributes, so there is no whole row to be stale.
   */
  it('cannot erase an acceptance, because it never writes a whole row', async () => {
    await putQuote(quote())
    // The handler reads the quote when the customer opens the page.
    const asHandlerRead = await getQuote('T1', 'Q1')
    expect(asHandlerRead?.status).toBe('sent')

    // Meanwhile the customer accepts. The row now carries a signed record.
    const accepted = quote({
      status: 'accepted',
      acceptance: { name: 'Marie', documentHash: 'abc', check: 'name' },
    })
    await putQuote(accepted)

    // What the OLD code did with that stale copy, spelled out. Kept so the
    // regression stays visible rather than merely fixed.
    await putQuote({ ...(asHandlerRead as object), viewCount: 1 } as never)
    expect((await getQuote('T1', 'Q1'))?.status).toBe('sent')
    expect((await getQuote('T1', 'Q1'))?.acceptance).toBeUndefined()

    // The same race through the current API leaves the acceptance alone.
    await putQuote(accepted)
    await countQuoteView('T1', 'Q1', '2026-08-28T10:00:00.000Z')

    const after = await getQuote('T1', 'Q1')
    expect(after?.status).toBe('accepted')
    expect((after?.acceptance as { name?: string })?.name).toBe('Marie')
    expect(after?.viewCount).toBe(1)
  })

  it('does not disturb the figures, which are what was agreed to', async () => {
    await putQuote(quote({ totalCents: 33500 }))
    await countQuoteView('T1', 'Q1', '2026-08-28T10:00:00.000Z')
    const q = await getQuote('T1', 'Q1')
    expect(q?.totalCents).toBe(33500)
    expect(q?.publicToken).toBe('tok')
  })

  // Several people opening a link at once is the ordinary case for a link
  // shared into a family group chat.
  it('loses no counts when views arrive together', async () => {
    await putQuote(quote())
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        countQuoteView('T1', 'Q1', `2026-08-28T10:0${i}:00.000Z`)),
    )
    expect((await getQuote('T1', 'Q1'))?.viewCount).toBe(8)
  })

  // A bounce or a scan for a quote that has since been deleted must not
  // recreate it as a stub holding nothing but view counts.
  it('refuses to create a row that is not there', async () => {
    await expect(countQuoteView('T1', 'GONE', '2026-08-28T10:00:00.000Z'))
      .rejects.toMatchObject({ name: 'ConditionalCheckFailedException' })
    expect(await getQuote('T1', 'GONE')).toBeUndefined()
  })
})
