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
   * Callers decide what that means. A counter of FAILURES should fail open -
   * losing the ceiling for a few minutes is better than telling a customer
   * they cannot accept their quote. A counter guarding expensive work should
   * fail closed.
   */
  unavailable?: boolean
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
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE(),
      Key: { pk: `${bucket}#${windowId}`, sk: id },
      UpdateExpression: 'ADD n :one SET expiresAt = if_not_exists(expiresAt, :exp)',
      ConditionExpression: 'attribute_not_exists(n) OR n < :limit',
      ExpressionAttributeValues: {
        ':one': 1,
        ':limit': limit,
        ':exp': Math.floor(Date.now() / 1000) + windowSeconds * 2,
      },
    }))
    return { ok: true }
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return { ok: false }
    console.error('rate limit check failed', { bucket, err: String(err) })
    return { ok: true, unavailable: true }
  }
}

/**
 * How many wrong answers a document accepts before it stops listening.
 *
 * Keyed on the TOKEN, not the caller's address. The check being protected is
 * the last four digits of a phone number - 10,000 possibilities - and an
 * attacker who can hold the link can also change address. Per-IP alone would
 * be theatre against exactly the attack it is supposed to stop.
 *
 * Ten is generous for a customer squinting at a number they were sent weeks
 * ago, and useless to somebody working through 10,000.
 */
export const ACCEPT_FAILURES = { limit: 10, windowSeconds: 60 * 60 } as const

/**
 * Counted only on a FAILED attempt.
 *
 * Counting every attempt would mean a customer who accepts, then opens the
 * page again, spends their own allowance on nothing. The thing worth limiting
 * is wrong guesses.
 */
export const claimAcceptFailure = (token: string): Promise<LimitResult> =>
  claimAttempt('accept-fail', token, ACCEPT_FAILURES.limit, ACCEPT_FAILURES.windowSeconds)

/**
 * A ceiling on how many different documents one address may probe.
 *
 * Catches the other shape: not 10,000 guesses at one token, but a sweep across
 * many. Generous, because a household can share an address and a tradesperson
 * may open several of their own links from one office connection.
 */
export const claimDocumentProbe = (ip: string): Promise<LimitResult> =>
  claimAttempt('doc-probe', ip, 120, 60 * 60)
