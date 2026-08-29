import { describe, expect, it, vi } from 'vitest'
import { TIERS, tierFor } from './sendcap'

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }))
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
  UpdateCommand: class {}, GetCommand: class {}, PutCommand: class {},
  QueryCommand: class {}, DeleteCommand: class {}, ScanCommand: class {},
}))

/**
 * The rules behind the daily send cap (issue 134).
 *
 * What this is defending: contacts import 2,000 rows at a time and the
 * review-ask endpoint will email any of them, so without a cap a free
 * workspace is two API calls away from a bulk send. That is also the exact
 * capability the SES appeal claims the product does not have.
 *
 * `tierFor` is pure so these rules can be tested without a database, which
 * matters because the rules are the part with judgement in them.
 */

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-01T00:00:00.000Z')

describe('send tiers', () => {
  it('gives an unverified workspace no optional mail at all', () => {
    const t = tierFor({}, NOW)
    expect(t.tier).toBe(0)
    expect(t.optionalPerDay).toBe(0)
  })

  /**
   * The rule the whole design turns on. A booking confirmation carries the
   * only cancel link the customer will ever get, so capping transactional
   * mail to zero would not reduce complaints - it would produce no-shows and
   * a broken product. Unverified workspaces send, just not in bulk.
   */
  it('still lets an unverified workspace send what customers are waiting for', () => {
    expect(tierFor({}, NOW).transactionalPerDay).toBeGreaterThan(0)
  })

  it('treats Stripe Connect onboarding as proof of a real business', () => {
    expect(tierFor({ payoutsEnabled: true }, NOW).tier).toBe(1)
  })

  it('treats paying and comped workspaces as verified too', () => {
    expect(tierFor({ paid: true }, NOW).tier).toBe(1)
  })

  it('promotes a verified workspace after a clean fortnight, not before', () => {
    const onboarded = (days: number) =>
      new Date(NOW - days * DAY).toISOString()
    expect(tierFor({ payoutsEnabled: true, verifiedSince: onboarded(13) }, NOW).tier).toBe(1)
    expect(tierFor({ payoutsEnabled: true, verifiedSince: onboarded(14) }, NOW).tier).toBe(2)
  })

  /**
   * The brake has to beat every other signal. A paying, long-verified
   * workspace generating spam reports is precisely the one that can cost
   * every other workspace their deliverability.
   */
  it('drops a restricted workspace to the bottom however verified it is', () => {
    const t = tierFor({
      payoutsEnabled: true,
      paid: true,
      verifiedSince: new Date(NOW - 400 * DAY).toISOString(),
      sendingRestrictedAt: '2026-08-30T00:00:00.000Z',
    }, NOW)
    expect(t.tier).toBe(0)
    expect(t.optionalPerDay).toBe(0)
  })

  it('does not promote on an unparseable date', () => {
    expect(tierFor({ payoutsEnabled: true, verifiedSince: 'whenever' }, NOW).tier).toBe(1)
  })

  it('never lets a lower tier out-send a higher one', () => {
    const tiers = [TIERS[0], TIERS[1], TIERS[2]]
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i].transactionalPerDay).toBeGreaterThan(tiers[i - 1].transactionalPerDay)
      expect(tiers[i].optionalPerDay).toBeGreaterThanOrEqual(tiers[i - 1].optionalPerDay)
    }
  })
})
