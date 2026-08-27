import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from '@makerbay/core'

/**
 * Caps for the one endpoint anyone on the internet can reach.
 *
 * Everything else in MakerBay is behind the authorizer. This is not: a
 * stranger pastes a web address and we fetch it, run headless Chromium if the
 * page needs rendering, and call Bedrock. That is the most expensive
 * unauthenticated thing the platform does, and the platform-wide stage
 * throttle (50 req/s) is far too coarse to protect it - one script at two
 * requests a second stays well under the throttle and still burns a day's
 * model budget.
 *
 * So this counts per caller, per day, in DynamoDB, with the increment and
 * the limit check in a single conditional write. Two callers racing cannot
 * both pass a check-then-increment.
 */

const TABLE = () => process.env.TABLE_SETUPJOBS!

/** A day's allowance. Deliberately small: a real person needs one or two. */
export const CAPS = { ip: 5, email: 3, global: 200 } as const

export type CapKind = keyof typeof CAPS

const today = () => new Date().toISOString().slice(0, 10)

/**
 * Claim one unit of an allowance. Returns false when it is spent.
 *
 * The counter and the limit are enforced in one `UpdateCommand`: the
 * condition refuses the write when the count is already at the cap, so the
 * check cannot be won by a racing request the way a read-then-write can.
 */
export async function claim(kind: CapKind, id: string): Promise<boolean> {
  const key = id.trim().toLowerCase().slice(0, 200)
  if (!key) return false
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE(),
      Key: { pk: `cap#${kind}#${today()}`, sk: key },
      UpdateExpression: 'ADD n :one SET expiresAt = if_not_exists(expiresAt, :exp)',
      ConditionExpression: 'attribute_not_exists(n) OR n < :cap',
      ExpressionAttributeValues: {
        ':one': 1,
        ':cap': CAPS[kind],
        // Two days, so a counter outlives the day it belongs to and then goes.
        ':exp': Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60,
      },
    }))
    return true
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false
    // A cap that cannot be recorded must not silently become no cap at all.
    console.error('cap claim failed', { kind, err: String(err) })
    return false
  }
}

/** The address a request came from, as far as API Gateway can tell. */
export const callerIp = (event: {
  requestContext: { http: { sourceIp?: string } }
  headers?: Record<string, string | undefined>
}): string => {
  // X-Forwarded-For is caller-supplied and trivially spoofed, so it is only a
  // tiebreaker. sourceIp is what API Gateway observed and is the one that
  // counts.
  const observed = event.requestContext.http.sourceIp
  return observed && observed.length > 2 ? observed : 'unknown'
}
