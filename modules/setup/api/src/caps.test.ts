import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The only endpoint a stranger can reach drives headless Chromium and
 * Bedrock, so these caps are the thing standing between a script and a day's
 * model budget. The platform-wide 50 req/s throttle does not help: two
 * requests a second stays far under it and still burns everything.
 */

let store: Map<string, number>

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }))
vi.mock('@aws-sdk/lib-dynamodb', () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    DynamoDBDocumentClient: { from: () => ({
      send: async (c: Cmd) => {
        const key = c.input.Key as Record<string, string>
        const vals = c.input.ExpressionAttributeValues as Record<string, number>
        const id = `${key.pk}|${key.sk}`
        const now = store.get(id) ?? 0
        // Mirrors `attribute_not_exists(n) OR n < :cap`.
        if (store.has(id) && now >= vals[':cap']) {
          const e = new Error('cap') as Error & { name: string }
          e.name = 'ConditionalCheckFailedException'
          throw e
        }
        store.set(id, now + 1)
        return {}
      },
    }) },
    UpdateCommand: Cmd,
    PutCommand: Cmd, GetCommand: Cmd, QueryCommand: Cmd, DeleteCommand: Cmd, ScanCommand: Cmd,
  }
})

const { CAPS, callerIp, claim } = await import('./caps')

describe('claim', () => {
  beforeEach(() => {
    store = new Map()
    process.env.TABLE_SETUPJOBS = 'makerbay-setup-jobs'
  })

  it('allows exactly the allowance, then refuses', async () => {
    for (let i = 0; i < CAPS.ip; i++) {
      expect(await claim('ip', '1.2.3.4'), `attempt ${i + 1}`).toBe(true)
    }
    expect(await claim('ip', '1.2.3.4')).toBe(false)
    expect(await claim('ip', '1.2.3.4')).toBe(false)
  })

  it('counts each caller separately', async () => {
    for (let i = 0; i < CAPS.ip; i++) await claim('ip', '1.2.3.4')
    expect(await claim('ip', '5.6.7.8')).toBe(true)
  })

  it('counts each kind separately, so one cap cannot exhaust another', async () => {
    for (let i = 0; i < CAPS.email; i++) await claim('email', 'a@b.com')
    expect(await claim('email', 'a@b.com')).toBe(false)
    expect(await claim('ip', 'a@b.com')).toBe(true)
  })

  it('treats an address as the same caller whatever the case or spacing', async () => {
    for (let i = 0; i < CAPS.email; i++) await claim('email', 'Dave@Example.com')
    expect(await claim('email', '  dave@example.com  ')).toBe(false)
  })

  it('refuses an empty identity rather than counting everyone as one caller', async () => {
    expect(await claim('ip', '')).toBe(false)
    expect(await claim('email', '   ')).toBe(false)
  })

  it('has a global cap as the backstop when per-caller limits are evaded', async () => {
    expect(CAPS.global).toBeGreaterThan(CAPS.ip)
    expect(CAPS.global).toBeGreaterThan(CAPS.email)
  })
})

describe('callerIp', () => {
  const ev = (sourceIp?: string, headers?: Record<string, string>) =>
    ({ requestContext: { http: { sourceIp } }, headers }) as never

  it('uses what API Gateway observed', () => {
    expect(callerIp(ev('203.0.113.9'))).toBe('203.0.113.9')
  })

  // The header is caller-supplied. Trusting it would make every cap here
  // bypassable by adding a line to a request.
  it('ignores a spoofed X-Forwarded-For', () => {
    expect(callerIp(ev('203.0.113.9', { 'x-forwarded-for': '1.1.1.1' }))).toBe('203.0.113.9')
  })

  it('falls back to one bucket rather than none when there is no address', () => {
    expect(callerIp(ev(undefined, { 'x-forwarded-for': '1.1.1.1' }))).toBe('unknown')
  })
})
