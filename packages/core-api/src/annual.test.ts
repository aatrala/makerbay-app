import { describe, expect, it, vi } from 'vitest'

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }))
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
  GetCommand: class {}, PutCommand: class {}, QueryCommand: class {},
  UpdateCommand: class {}, DeleteCommand: class {}, ScanCommand: class {},
}))

const {
  annualPriceCents, ANNUAL_PRICE_CENTS, FOUNDING_ANNUAL_PRICE_CENTS,
  FOUNDING_PRICE_CENTS, MONTHS_FREE_ON_ANNUAL, PLANS,
} = await import('./stripe-client')

/**
 * Annual pricing arithmetic (issue 145).
 *
 * The pricing page has said "two months free" since it existed, and the
 * annual amount was a typed-in constant sitting next to a monthly one it had
 * no relationship with. Two months free was true only for as long as nobody
 * changed a price - and Genie had no annual option at all, so a customer who
 * wanted to prepay simply could not.
 *
 * These test the promise rather than the numbers: "annual is ten months" is
 * the claim on the page, and the numbers are the founder's to change.
 */

describe('annual pricing', () => {
  it('is exactly two months free on every paid plan', () => {
    for (const id of ['pro', 'genie']) {
      const monthly = PLANS[id].monthlyPriceCents
      expect(annualPriceCents(id), id).toBe(monthly * 10)
      // The same claim, stated the way the page states it.
      expect(monthly * 12 - annualPriceCents(id), id).toBe(monthly * MONTHS_FREE_ON_ANNUAL)
    }
  })

  it('gives the founding rate the same discount as everyone else', () => {
    expect(FOUNDING_ANNUAL_PRICE_CENTS).toBe(FOUNDING_PRICE_CENTS * 10)
  })

  /**
   * A founding member choosing annual must not quietly lose the discount.
   * Before this, annual had one price for everybody, so committing hardest
   * was the moment the founding rate disappeared.
   */
  it('keeps the founding annual price below the standard annual price', () => {
    expect(FOUNDING_ANNUAL_PRICE_CENTS).toBeLessThan(annualPriceCents('pro'))
  })

  it('never lets annual cost more than twelve months', () => {
    for (const id of ['pro', 'genie']) {
      expect(annualPriceCents(id), id).toBeLessThan(PLANS[id].monthlyPriceCents * 12)
    }
  })

  it('keeps the legacy Trade constant in step with the derived one', () => {
    expect(ANNUAL_PRICE_CENTS).toBe(annualPriceCents('pro'))
  })

  it('produces the round numbers the marketing pages quote', () => {
    expect(annualPriceCents('pro')).toBe(29000)
    expect(annualPriceCents('genie')).toBe(99000)
    expect(FOUNDING_ANNUAL_PRICE_CENTS).toBe(19000)
  })

  it('refuses a plan it does not know, rather than inventing a price', () => {
    expect(() => annualPriceCents('enterprise')).toThrow()
  })
})
