import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * One way out of the building (issue 132).
 *
 * Every guarantee this product makes about email lives inside sendEmail: the
 * per-tenant suppression check, the unsubscribe headers, the header-injection
 * escaping, the config set that makes bounces observable, and the ref that
 * writes a delivery failure back onto the quote or invoice that caused it.
 *
 * None of that is enforced by the type system. A second SendEmailCommand
 * somewhere else compiles, deploys, and sends - it just quietly has none of
 * the guarantees. That is exactly what happened: the support ticket reply was
 * hand-rolled, so for months we mailed addresses already known to be dead and
 * the founder's own template review never saw it, because it was not a
 * template.
 *
 * This test is the enforcement. It reads the tree rather than trusting review.
 */

const ROOT = process.cwd()

/**
 * Files allowed to construct a raw SendEmailCommand, and how many.
 *
 * The count matters as much as the name: admin-api is on the list for ONE
 * call, the SES diagnostic, and a second one appearing in the same file is
 * the regression this test exists to catch.
 */
const ALLOWED: Record<string, number> = {
  // The one sender. Everything else goes through it.
  'packages/core/src/notify.ts': 1,
  /*
   * The staff "send a test email" button, which exists to prove SES itself is
   * working - domain verified, DKIM signing, config set applied, out of the
   * sandbox. Routing it through sendEmail would test sendEmail instead, which
   * is the one thing it must not do. It only ever sends to the staff member's
   * own address, so it cannot become a way to reach a customer.
   */
  'packages/admin-api/src/handler.ts': 1,
}

const SKIP = new Set(['node_modules', 'dist', 'cdk.out', '.git', 'build', 'coverage'])

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

describe('email sending', () => {
  it('goes through sendEmail everywhere except the documented exceptions', () => {
    const offenders: string[] = []
    for (const file of sources(ROOT)) {
      const rel = relative(ROOT, file).split(sep).join('/')
      const count = (readFileSync(file, 'utf8').match(/new SendEmailCommand\(/g) ?? []).length
      if (count === 0) continue
      const allowed = ALLOWED[rel] ?? 0
      if (count > allowed) {
        offenders.push(`${rel}: ${count} raw SendEmailCommand, ${allowed} allowed`)
      }
    }
    expect(
      offenders,
      'Use sendEmail() from @makerbay/core. It carries the suppression check, '
        + 'the unsubscribe headers and the delivery tracking that a raw '
        + 'SendEmailCommand silently skips. If a new exception is genuinely '
        + 'right, add it to ALLOWED above with the reason.',
    ).toEqual([])
  })

  // A guard nobody can see the scope of is a guard that rots.
  it('actually scans the tree it claims to', () => {
    const files = sources(ROOT)
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((f) => f.includes('admin-api'))).toBe(true)
    expect(files.some((f) => f.includes(join('modules', 'quotes')))).toBe(true)
  })
})
