import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from './db'

/**
 * How much customer-bound mail one workspace may send in a day (issue 134).
 *
 * The problem this closes: contacts can be imported 2,000 rows at a time, and
 * the review-ask endpoint will email a pasted Google review link to any one of
 * them with no entitlement check and no cap. That is a list upload and a bulk
 * send two API calls apart, available on a free workspace, and it is the exact
 * thing the SES production-access appeal claims the product cannot do.
 *
 * Three decisions worth stating, because each had an obvious wrong answer.
 *
 * **Tier on verification, not payment.** The instinct is to put customer email
 * behind the paywall. But the booking confirmation is the only thing that
 * carries the cancel token, so a free tier that books people and never
 * confirms produces no-shows and phone calls - more complaints, not fewer, and
 * a broken product besides. What actually separates a plumber from a spammer
 * is whether they are a real business, and Stripe Connect already establishes
 * that for free: `payoutsEnabled` means somebody passed KYC with a real bank
 * account. So that, or any live grant, is the gate.
 *
 * **Optional mail is where the cap bites.** Review asks and digests are the
 * messages recipients complain about - they carry an unsubscribe link for
 * exactly that reason. An unverified workspace gets none of them. That single
 * rule closes the bulk vector and costs a legitimate sole trader nothing,
 * because free bookings cap at 20 a month anyway.
 *
 * **The counter lives in MailLog.** Not the RateLimit table, which is granted
 * to the quotes Lambda alone; MailLog is already granted to every Lambda that
 * sends, so this needs no infrastructure change at all - which matters at 492
 * of a hard 500 CloudFormation resources. MailLog already parks non-message
 * rows under reserved `messageId` prefixes (`addr#`, `unsub#`), so `cap#` joins
 * an established convention rather than inventing one.
 */

const TABLE = () => process.env.TABLE_MAILLOG!

export type SendTier = 0 | 1 | 2

export interface TierLimits {
  tier: SendTier
  /** Messages the recipient is waiting for: confirmations, quotes, invoices. */
  transactionalPerDay: number
  /** Review asks and digests. Zero until a workspace is verified. */
  optionalPerDay: number
}

export const TIERS: Record<SendTier, Omit<TierLimits, 'tier'>> = {
  // New or unverified. Generous for one person doing real work, useless for
  // anyone with a list: 25 a day against a free booking cap of 20 a month.
  0: { transactionalPerDay: 25, optionalPerDay: 0 },
  // A real business: Stripe Connect onboarded, or paying, or comped.
  1: { transactionalPerDay: 200, optionalPerDay: 50 },
  // Verified and sending cleanly for a fortnight.
  2: { transactionalPerDay: 1000, optionalPerDay: 250 },
}

export interface TenantSendState {
  payoutsEnabled?: boolean
  paid?: boolean
  /**
   * ISO date the workspace first qualified for tier 1. In practice this is
   * `connectOnboardedAt`, which the payments module already writes when
   * Stripe Connect onboarding completes. A workspace verified only by a paid
   * grant has no such date and simply stays on tier 1, which is generous
   * enough that nobody notices.
   */
  verifiedSince?: string
  /** Set by the complaint auto-brake; forces tier 0 regardless. */
  sendingRestrictedAt?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Which tier a workspace is on, from state the caller has already read.
 *
 * Pure, so the rules can be tested without a database and so the caller
 * decides how to fetch. The restriction check comes first: a workspace the
 * complaint brake has caught is tier 0 whatever else is true of it.
 */
export function tierFor(state: TenantSendState, now = Date.now()): TierLimits {
  if (state.sendingRestrictedAt) return { tier: 0, ...TIERS[0] }
  const verified = state.payoutsEnabled === true || state.paid === true
  if (!verified) return { tier: 0, ...TIERS[0] }
  const since = state.verifiedSince ? Date.parse(state.verifiedSince) : NaN
  const warmed = Number.isFinite(since) && now - since >= 14 * DAY_MS
  return warmed ? { tier: 2, ...TIERS[2] } : { tier: 1, ...TIERS[1] }
}

export interface ClaimResult {
  ok: boolean
  /** True when the check itself failed, so the caller can fail open safely. */
  unavailable?: boolean
}

/**
 * Take one message from today's allowance, or refuse.
 *
 * A single conditional ADD, so check-then-increment cannot be raced by two
 * Lambdas sending at once. Copied in shape from claimAttempt in ratelimit.ts,
 * which solved the same problem for PIN guesses.
 */
export async function claimSend(
  tenantId: string,
  optional: boolean,
  limit: number,
  now = new Date(),
): Promise<ClaimResult> {
  if (limit <= 0) return { ok: false }
  const day = now.toISOString().slice(0, 10)
  const field = optional ? 'nOpt' : 'n'
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE(),
      Key: { tenantId, messageId: `cap#${day}` },
      // Every name aliased. `n` is short enough to collide with something in
      // DynamoDB's long reserved list, and a ValidationException here would
      // fail open on every send while the unit tests stayed green - which is
      // precisely how issue 107's `at` shipped.
      UpdateExpression: 'ADD #f :one SET #exp = if_not_exists(#exp, :exp)',
      ConditionExpression: 'attribute_not_exists(#f) OR #f < :limit',
      ExpressionAttributeNames: { '#f': field, '#exp': 'expiresAt' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':limit': limit,
        // Two days, so a row outlives the day it counts and then goes away.
        ':exp': Math.floor(now.getTime() / 1000) + 2 * 24 * 60 * 60,
      },
    }))
    return { ok: true }
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return { ok: false }
    }
    console.error('send cap check failed', { tenantId, err: String(err) })
    return { ok: true, unavailable: true }
  }
}

/**
 * Stop a workspace sending optional mail after too many complaints.
 *
 * Deliberately NOT setTenantStatus('suspended'): the authorizer refuses
 * suspended tenants outright, so suspending would lock the owner out of the
 * dashboard, including the screen that would explain why. This restricts
 * sending and leaves them able to read, understand and appeal it.
 */
export async function restrictSending(tenantId: string, reason: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: process.env.TABLE_TENANTS!,
    Key: { tenantId },
    UpdateExpression: 'SET #at = :at, #why = :why',
    ExpressionAttributeNames: { '#at': 'sendingRestrictedAt', '#why': 'sendingRestrictedReason' },
    ExpressionAttributeValues: { ':at': new Date().toISOString(), ':why': reason.slice(0, 200) },
    ConditionExpression: 'attribute_exists(tenantId)',
  })).catch((err) => {
    console.error('could not restrict sending', { tenantId, err: String(err) })
  })
}

/** Complaints in a rolling day that trip the brake. */
export const COMPLAINT_BRAKE = 3

/**
 * Count one complaint and say whether the brake should trip.
 *
 * Same conditional-ADD shape, but the condition is inverted: we always want
 * the increment to land, and the count back, so the caller decides.
 */
export async function countComplaint(tenantId: string, now = new Date()): Promise<number> {
  const day = now.toISOString().slice(0, 10)
  try {
    const r = await ddb.send(new UpdateCommand({
      TableName: TABLE(),
      Key: { tenantId, messageId: `cap#${day}` },
      UpdateExpression: 'ADD #c :one SET #exp = if_not_exists(#exp, :exp)',
      ExpressionAttributeNames: { '#c': 'nComplaints', '#exp': 'expiresAt' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':exp': Math.floor(now.getTime() / 1000) + 2 * 24 * 60 * 60,
      },
      ReturnValues: 'UPDATED_NEW',
    }))
    return Number((r.Attributes as { nComplaints?: number } | undefined)?.nComplaints ?? 0)
  } catch (err) {
    console.error('complaint count failed', { tenantId, err: String(err) })
    return 0
  }
}
