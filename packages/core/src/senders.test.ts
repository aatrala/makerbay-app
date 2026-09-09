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
  /*
   * The one SES sender, below sendEmail (issue 156). Everything else goes
   * through sendEmail, which decides the message and hands it to the active
   * provider. The staff "send a test email" button used to hold a second
   * raw command; it now calls the provider layer's `deliver()`, which is
   * still below sendEmail - the point of that button - without a second copy
   * of the wire format.
   */
  'packages/core/src/mail/ses.ts': 1,
}

/**
 * The same rule for the other provider. There is no SDK to grep for, so the
 * guard is the API host: only the Resend adapter may know it.
 */
const RESEND_ALLOWED = new Set([
  'packages/core/src/mail/resend.ts',
  // The signup canary READS Resend's delivery log to confirm a code arrived
  // (issue 158). It never sends; the code request goes through the live
  // auth endpoint like any customer's.
  'packages/core-api/src/signup-canary.ts',
])

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

  it('talks to Resend from exactly one file', () => {
    const offenders: string[] = []
    for (const file of sources(ROOT)) {
      const rel = relative(ROOT, file).split(sep).join('/')
      if (RESEND_ALLOWED.has(rel)) continue
      if (/api\.resend\.com/.test(readFileSync(file, 'utf8'))) offenders.push(rel)
    }
    expect(
      offenders,
      'Use sendEmail() or, for a diagnostic, deliver() from @makerbay/core. '
        + 'A second copy of the provider call skips every guarantee sendEmail carries.',
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
