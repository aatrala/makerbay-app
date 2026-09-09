import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifySvix } from './svix'

/**
 * The webhook endpoint has no authorizer; this function IS the authorizer.
 * A wrong answer in the permissive direction lets anyone on the internet
 * mark a customer's address as dead.
 */
const SECRET = 'whsec_' + Buffer.from('a-test-key-of-reasonable-length').toString('base64')
const key = Buffer.from(SECRET.slice(6), 'base64')
const sign = (id: string, ts: string, body: string) =>
  createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')

const now = 1_760_000_000_000
const ts = String(Math.floor(now / 1000))
const body = '{"type":"email.delivered","data":{"email_id":"E1"}}'

describe('verifySvix', () => {
  it('accepts a correctly signed request', () => {
    const signature = `v1,${sign('msg_1', ts, body)}`
    expect(verifySvix({ secret: SECRET, id: 'msg_1', timestamp: ts, signature, body, nowMs: now })).toBe(true)
  })

  it('accepts when any one of several listed signatures matches', () => {
    const signature = `v1,${Buffer.from('nope').toString('base64')} v1,${sign('msg_1', ts, body)}`
    expect(verifySvix({ secret: SECRET, id: 'msg_1', timestamp: ts, signature, body, nowMs: now })).toBe(true)
  })

  it('rejects a body that changed by one character', () => {
    const signature = `v1,${sign('msg_1', ts, body)}`
    expect(verifySvix({ secret: SECRET, id: 'msg_1', timestamp: ts, signature, body: body + ' ', nowMs: now })).toBe(false)
  })

  it('rejects the wrong secret', () => {
    const signature = `v1,${sign('msg_1', ts, body)}`
    const other = 'whsec_' + Buffer.from('some-other-key').toString('base64')
    expect(verifySvix({ secret: other, id: 'msg_1', timestamp: ts, signature, body, nowMs: now })).toBe(false)
  })

  // A captured request replayed a day later must not be able to re-mark an
  // address the staff console has since cleared.
  it('rejects a stale timestamp', () => {
    const signature = `v1,${sign('msg_1', ts, body)}`
    expect(verifySvix({ secret: SECRET, id: 'msg_1', timestamp: ts, signature, body, nowMs: now + 10 * 60 * 1000 })).toBe(false)
  })

  it('rejects missing headers rather than throwing', () => {
    expect(verifySvix({ secret: SECRET, body, nowMs: now })).toBe(false)
    expect(verifySvix({ secret: SECRET, id: 'x', timestamp: 'abc', signature: 'v1,zz', body, nowMs: now })).toBe(false)
  })

  it('ignores signature versions it does not know', () => {
    const signature = `v2,${sign('msg_1', ts, body)}`
    expect(verifySvix({ secret: SECRET, id: 'msg_1', timestamp: ts, signature, body, nowMs: now })).toBe(false)
  })
})
