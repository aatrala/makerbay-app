import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every state-changing admin route checks a role (issue 131a).
 *
 * The authorizer read `role` and the audit row recorded it, and for months
 * not one route checked it - so any staff member could suspend a tenant,
 * grant an entitlement, reset an owner's password and read any workspace's
 * customer conversations. The risk was bounded only by there being one of us.
 *
 * It is also now a published commitment: Annex II of the DPA at
 * makerbay.app/dpa says role-based limits are in place by 31 October 2026.
 *
 * This test reads the route table rather than mocking a request, because the
 * failure it defends against is a NEW route added without a guard - which no
 * amount of testing the existing ones would catch. A route that changes state
 * and never mentions hasRole is the bug.
 */

const SOURCE = readFileSync(
  join(process.cwd(), 'packages/admin-api/src/handler.ts'),
  'utf8',
)

/** The route-table block, which is where guards have to appear. */
const routeTable = SOURCE.slice(
  SOURCE.indexOf('const staff = event.requestContext.authorizer.lambda'),
  SOURCE.indexOf("return json(404, { error: 'not_found' })"),
)

/**
 * Handlers that change state, or read another business's customer content.
 * Reading platform-level lists is support work and stays open.
 */
const MUST_BE_GUARDED = [
  'createGrant',
  'revoke(',
  'setSuspension',
  'resetPassword',
  'suppressionRemove',
  'conversations(',
  'auditLog',
  'sendTestEmail',
]

describe('admin roles', () => {
  it('guards every route that changes state or reads customer content', () => {
    const unguarded: string[] = []
    for (const fn of MUST_BE_GUARDED) {
      const at = routeTable.indexOf(fn)
      expect(at, `${fn} is not in the route table any more - update this test`).toBeGreaterThan(-1)
      // The guard must sit in the same branch, just above the call.
      /*
       * Scoped to THIS branch, not a fixed lookback.
       *
       * A 400-character window silently passed when a guard was deleted,
       * because it reached back into the previous route's guard - the exact
       * class of test that cannot fail, which this file exists to avoid.
       * Anchoring on the nearest preceding `if (method ===` keeps the search
       * inside the branch that actually calls the handler.
       */
      const branchStart = routeTable.lastIndexOf('if (method ===', at)
      const branch = routeTable.slice(branchStart, at)
      if (!branch.includes('hasRole(staff')) unguarded.push(fn)
    }
    expect(
      unguarded,
      'These admin routes change state or expose customer content and do not '
        + 'check a role. Add `if (!hasRole(staff, "admin"|"owner")) return await '
        + 'denyRole(...)` above the call, or explain in this test why the route '
        + 'is safe for a support account.',
    ).toEqual([])
  })

  it('has the three tiers in the order the guards assume', () => {
    expect(SOURCE).toContain("const ROLES: Record<string, number> = { support: 0, admin: 1, owner: 2 }")
  })

  /**
   * A missing role must land on the LEAST privilege, not the most. The
   * authorizer is where that is decided, so it is checked here too - the two
   * files have to agree for any of this to mean anything.
   */
  it('defaults an absent role to support', () => {
    const authorizer = readFileSync(
      join(process.cwd(), 'packages/admin-api/src/authorizer.ts'),
      'utf8',
    )
    expect(authorizer).toContain("staff.role ?? 'support'")
  })

  it('records a refusal in the audit log, not just a 403', () => {
    const deny = SOURCE.slice(SOURCE.indexOf('async function denyRole'))
    expect(deny.slice(0, 600)).toContain("'denied'")
  })
})
