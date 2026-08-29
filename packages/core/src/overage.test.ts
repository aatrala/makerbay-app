import { describe, expect, it, vi } from 'vitest'
import { resolveEntitlement, type Grant } from './entitlements'

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }))
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
  DeleteCommand: class {}, PutCommand: class {}, QueryCommand: class {}, UpdateCommand: class {},
  GetCommand: class {}, ScanCommand: class {}, BatchGetCommand: class {},
}))

/**
 * The pricing page's promise, as a test (issue 138).
 *
 * "$0.02 each, opt-in - the default is a polite stop", and in the FAQ, "never
 * a surprise bill". Both sentences were on the live page while
 * resolveEntitlement returned 'billed' for every Stripe-backed paid grant the
 * moment the webhook landed. There was no opt-in anywhere in the product to
 * opt in to.
 *
 * Opaque billing is the loudest complaint in this market and the reason that
 * sentence is on the page in the first place, so of all the promises to break
 * accidentally, this was the worst available. These tests exist so the
 * sentence and the code cannot drift apart again silently.
 */

const stripeGrant = (over: Partial<Grant> = {}): Grant => ({
  tenantId: 'T', sk: 'GRANT#assistant#stripe', moduleId: 'assistant',
  planTier: 'pro', source: 'stripe', status: 'active',
  limits: { messages: 2000 }, grantedBy: 'stripe-webhook',
  ...over,
} as Grant)

const resolve = (grants: Grant[], optIn?: boolean) =>
  resolveEntitlement('assistant', grants, true, undefined, optIn)

describe('message overage', () => {
  it('stops politely by default, even on a paid plan', () => {
    expect(resolve([stripeGrant()]).overage).toBe('block')
  })

  it('bills only when the workspace has actually opted in', () => {
    expect(resolve([stripeGrant()], true).overage).toBe('billed')
  })

  it('never bills a free workspace, opt-in or not', () => {
    expect(resolve([], true).overage).toBe('block')
    expect(resolve([stripeGrant({ planTier: 'free' })], true).overage).toBe('block')
  })

  /**
   * A comp is a gift. Billing someone for exceeding a plan they were given
   * would be the single most embarrassing invoice this product could send,
   * and the opt-in must not become a back door to it.
   */
  it('never bills a comped workspace, even if they opted in', () => {
    const comp = stripeGrant({ source: 'manual', grantedBy: 'staff' })
    expect(resolve([comp], true).overage).toBe('block')
  })

  it('ignores an expired paid grant', () => {
    const expired = stripeGrant({ expiresAt: '2020-01-01T00:00:00.000Z' })
    expect(resolve([expired], true).overage).toBe('block')
  })
})
