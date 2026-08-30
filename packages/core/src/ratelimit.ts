import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from './db'

/**
 * A shared counter for public endpoints that need a ceiling.
 *
 * The platform-wide stage throttle is 50 req/s, which is far too coarse to
 * protect anything specific: a script at two requests a second stays well
 * under it and still gets 172,800 tries a day.
 *
 * The increment and the limit live in ONE conditional write, so a check-then-
 * increment cannot be won by a racing request.
 *
 * Its own table rather than a corner of an existing one: the quotes table is
 * queried by `tenantId` alone, so counter rows parked there would surface in
 * every quote list, and a security control that quietly corrupts a listing is
 * a bad trade for one saved resource.
 */

const TABLE = () => process.env.TABLE_RATELIMIT!

export interface LimitResult {
  /** False when the allowance is spent. */
  ok: boolean
  /**
   * True when the check could not run at all.
   *
   * Callers decide what that means. A counter of attempts should fail open -
   * losing the ceiling for a few minutes is better than telling a customer
   * they cannot accept their quote. A counter guarding expensive work should
   * fail closed.
   */
  unavailable?: boolean
}

/**
 * One counter row, described rather than hand-written.
 *
 * Every counter in the platform - PIN attempts, document probes, the daily
 * send cap, complaint counts, page-view stats - is the same DynamoDB shape:
 * ADD a field, set a TTL the first time, sometimes refuse past a limit. It
 * used to exist as four hand-written copies, which meant the next fix to the
 * shape (the aliasing rule below, for one) had to be found and applied four
 * times. Now the shape is written once and the callers choose table and key.
 */
export interface CounterSpec {
  table: string
  key: Record<string, unknown>
  /** Attribute holding the count. */
  field: string
  /** How long the row outlives its first write before TTL removes it. */
  ttlSeconds: number
  nowMs?: number
}

/**
 * Claim one unit, or refuse once `limit` is spent.
 *
 * Every name aliased. `n` is short enough to collide with something in
 * DynamoDB's long reserved list, and a ValidationException here would fail
 * open on every call while the unit tests stayed green - which is precisely
 * how issue 107's `at` shipped.
 */
export async function claimFromCounter(spec: CounterSpec & { limit: number }): Promise<LimitResult> {
  if (spec.limit <= 0) return { ok: false }
  const nowMs = spec.nowMs ?? Date.now()
  try {
    await ddb.send(new UpdateCommand({
      TableName: spec.table,
      Key: spec.key,
      UpdateExpression: 'ADD #f :one SET #exp = if_not_exists(#exp, :exp)',
      ConditionExpression: 'attribute_not_exists(#f) OR #f < :limit',
      ExpressionAttributeNames: { '#f': spec.field, '#exp': 'expiresAt' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':limit': spec.limit,
        ':exp': Math.floor(nowMs / 1000) + spec.ttlSeconds,
      },
    }))
    return { ok: true }
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return { ok: false }
    console.error('counter claim failed', { field: spec.field, err: String(err) })
    return { ok: true, unavailable: true }
  }
}

/**
 * Count one, unconditionally, and return the new total.
 *
 * For counters that inform rather than refuse: complaint counts, page views.
 * Returns 0 when the write failed - a lost count must never take down the
 * request that was being counted.
 */
export async function bumpCounter(spec: CounterSpec): Promise<number> {
  const nowMs = spec.nowMs ?? Date.now()
  try {
    const r = await ddb.send(new UpdateCommand({
      TableName: spec.table,
      Key: spec.key,
      UpdateExpression: 'ADD #f :one SET #exp = if_not_exists(#exp, :exp)',
      ExpressionAttributeNames: { '#f': spec.field, '#exp': 'expiresAt' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':exp': Math.floor(nowMs / 1000) + spec.ttlSeconds,
      },
      ReturnValues: 'UPDATED_NEW',
    }))
    return Number((r.Attributes as Record<string, unknown> | undefined)?.[spec.field] ?? 0)
  } catch (err) {
    console.error('counter bump failed', { field: spec.field, err: String(err) })
    return 0
  }
}

/**
 * Claim one unit against `key` in `bucket`.
 *
 * @param windowSeconds how long the counter lives. The row is TTL'd a little
 *   past it, so a window genuinely resets rather than accumulating forever.
 */
export async function claimAttempt(
  bucket: string,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<LimitResult> {
  const id = String(key ?? '').trim().toLowerCase().slice(0, 300)
  if (!id) return { ok: true }
  // The window start, so the key rolls over on its own rather than needing a
  // sweep. A fixed window is enough here: the attacker's gain from straddling
  // two windows is one extra allowance, against 10,000 guesses they need.
  const windowId = Math.floor(Date.now() / 1000 / windowSeconds)
  return claimFromCounter({
    table: TABLE(),
    key: { pk: `${bucket}#${windowId}`, sk: id },
    field: 'n',
    limit,
    ttlSeconds: windowSeconds * 2,
  })
}

/**
 * How many ACCEPT ATTEMPTS a document takes in an hour before it stops
 * listening.
 *
 * Keyed on the TOKEN, not the caller's address. The check being protected is
 * the last four digits of a phone number - 10,000 possibilities - and an
 * attacker who can hold the link can also change address. Per-IP alone would
 * be theatre against exactly the attack it is supposed to stop.
 *
 * Claimed BEFORE the guess is compared, and on every attempt. An earlier
 * version counted only failures, checked after verification - which meant the
 * one guess that matters, the correct one, never failed and so was never
 * stopped: a lockout that only converted wrong answers from 400 to 429.
 * Viewing is not counted, so a customer re-opening their page spends nothing;
 * ten attempts is generous for someone squinting at a number they were sent
 * weeks ago, and useless to somebody working through 10,000.
 */
export const ACCEPT_ATTEMPTS = { limit: 10, windowSeconds: 60 * 60 } as const

export const claimAcceptAttempt = (token: string): Promise<LimitResult> =>
  claimAttempt('accept-fail', token, ACCEPT_ATTEMPTS.limit, ACCEPT_ATTEMPTS.windowSeconds)

/**
 * A ceiling on how many different documents one address may probe.
 *
 * Catches the other shape: not 10,000 guesses at one token, but a sweep across
 * many. Generous, because a household can share an address and a tradesperson
 * may open several of their own links from one office connection.
 */
export const claimDocumentProbe = (ip: string): Promise<LimitResult> =>
  claimAttempt('doc-probe', ip, 120, 60 * 60)
