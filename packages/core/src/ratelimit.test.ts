import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The ceiling on wrong accept answers (issue 119 review).
 *
 * `phone4` is 10,000 possibilities, so before this the STRONGER accept setting
 * was the brute-forceable one - which made it falsely reassuring. A success
 * would have been recorded as a binding contract with a name, an IP and a
 * document hash.
 */

let store: Map<string, number>
let fail: string | undefined

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }))
vi.mock('@aws-sdk/client-eventbridge', () => ({ EventBridgeClient: class {}, PutEventsCommand: class {} }))
vi.mock('@aws-sdk/lib-dynamodb', () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    DynamoDBDocumentClient: { from: () => ({
      send: async (c: Cmd) => {
        if (fail) {
          const e = new Error(fail) as Error & { name: string }
          e.name = fail
          throw e
        }
        const k = c.input.Key as Record<string, string>
        const id = `${k.pk}|${k.sk}`
        const limit = (c.input.ExpressionAttributeValues as Record<string, number>)[':limit']
        const n = store.get(id) ?? 0
        // The real conditional: the write is refused at the cap, so the check
        // cannot be won by a racing request the way read-then-write can.
        if (n >= limit) {
          const e = new Error('cond') as Error & { name: string }
          e.name = 'ConditionalCheckFailedException'
          throw e
        }
        store.set(id, n + 1)
        return {}
      },
    }) },
    UpdateCommand: class extends Cmd {},
    PutCommand: class extends Cmd {},
    GetCommand: class extends Cmd {},
    QueryCommand: class extends Cmd {},
    DeleteCommand: class extends Cmd {},
    ScanCommand: class extends Cmd {},
  }
})

const { ACCEPT_FAILURES, claimAcceptFailure, claimAttempt } = await import('./ratelimit')

beforeEach(() => {
  store = new Map()
  fail = undefined
  process.env.TABLE_RATELIMIT = 'makerbay-ratelimit'
})

describe('claimAttempt', () => {
  it('allows up to the limit and refuses after', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await claimAttempt('b', 'k', 3, 60)).ok, `attempt ${i + 1}`).toBe(true)
    }
    expect((await claimAttempt('b', 'k', 3, 60)).ok).toBe(false)
  })

  it('counts each key separately', async () => {
    await claimAttempt('b', 'one', 1, 60)
    expect((await claimAttempt('b', 'one', 1, 60)).ok).toBe(false)
    expect((await claimAttempt('b', 'two', 1, 60)).ok).toBe(true)
  })

  it('counts each bucket separately', async () => {
    await claimAttempt('a', 'k', 1, 60)
    expect((await claimAttempt('b', 'k', 1, 60)).ok).toBe(true)
  })

  it('treats a key the same however it is cased or spaced', async () => {
    await claimAttempt('b', 'TOKEN', 1, 60)
    expect((await claimAttempt('b', ' token ', 1, 60)).ok).toBe(false)
  })

  /**
   * A counter of FAILURES fails open on purpose. Losing the ceiling for a few
   * minutes is better than telling a customer they cannot accept their quote
   * because a table was briefly unavailable.
   */
  it('fails open, and says so, when the check cannot run', async () => {
    fail = 'ProvisionedThroughputExceededException'
    const r = await claimAttempt('b', 'k', 1, 60)
    expect(r.ok).toBe(true)
    expect(r.unavailable).toBe(true)
  })

  it('does not spend an allowance on an empty key', async () => {
    expect((await claimAttempt('b', '', 1, 60)).ok).toBe(true)
    expect((await claimAttempt('b', '   ', 1, 60)).ok).toBe(true)
  })
})

describe('claimAcceptFailure', () => {
  it('stops a phone4 sweep long before 10,000 guesses', async () => {
    let allowed = 0
    for (let i = 0; i < 200; i++) {
      if ((await claimAcceptFailure('TOKEN-A')).ok) allowed++
    }
    expect(allowed).toBe(ACCEPT_FAILURES.limit)
    // 10,000 possibilities against a handful of tries is the whole point.
    expect(allowed).toBeLessThan(20)
  })

  /**
   * Keyed on the TOKEN, not the caller's address: someone who can hold the
   * link can also change address, so a per-IP cap alone would be theatre
   * against exactly the attack this stops.
   */
  it('is not escaped by changing address, because it counts per document', async () => {
    for (let i = 0; i < ACCEPT_FAILURES.limit; i++) await claimAcceptFailure('TOKEN-B')
    expect((await claimAcceptFailure('TOKEN-B')).ok).toBe(false)
  })

  it('does not punish a different customer for someone else exhausting theirs', async () => {
    for (let i = 0; i < ACCEPT_FAILURES.limit; i++) await claimAcceptFailure('TOKEN-C')
    expect((await claimAcceptFailure('TOKEN-D')).ok).toBe(true)
  })

  // A customer squinting at a number they were sent weeks ago gets room.
  it('leaves room for honest mistakes', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await claimAcceptFailure('TOKEN-E')).ok).toBe(true)
    }
  })
})
