import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Nothing on a public page may call a third party (issue 133).
 *
 * A tenant's booking page and help centre are read by homeowners who have no
 * relationship with MakerBay and never agreed to anything with us. Every
 * external asset on those pages hands that reader's IP address and user agent
 * to whoever serves it.
 *
 * This is not hypothetical tidiness. The privacy policy says of our
 * subprocessors: "The complete list. There is no one else." That sentence was
 * false for months because four font pairings and five help themes loaded
 * their faces from fonts.googleapis.com, and nobody noticed because a font is
 * not the sort of thing you think of as a data flow. The faces are now
 * vendored into our own bucket by scripts/vendor-fonts.mjs.
 *
 * The rule is easy to break again: adding a CDN script, an icon set, a map
 * embed or a captcha to a public page reintroduces exactly the same problem,
 * silently, and falsifies a published legal document. So the check is on the
 * whole host, not just on fonts.
 */

const ROOT = process.cwd()

/** Everything that renders HTML served to a tenant's own customers. */
const PUBLIC_RENDERERS = [
  'modules/presence/api/src',
  'modules/assistant/api/src',
  'modules/assistant/embed/src',
  'modules/quotes/api/src',
  'packages/core-api/src',
]

/** Hosts a public page must never reach out to. Not exhaustive; indicative. */
const FORBIDDEN = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'ajax.googleapis.com',
  'www.google-analytics.com',
  'googletagmanager.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
  'code.jquery.com',
  'www.gstatic.com',
]

const SKIP = new Set(['node_modules', 'dist', 'cdk.out', 'fonts'])

function sources(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.(ts|tsx|js|css|html)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * A mention in a comment is fine and often necessary - the vendoring script
 * and the explanations above both name the host they exist because of. What
 * matters is a URL the browser would actually fetch.
 */
const isComment = (line: string): boolean => {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#')
}

describe('public pages', () => {
  it('load nothing from a third party host', () => {
    const offences: string[] = []
    for (const base of PUBLIC_RENDERERS) {
      for (const file of sources(join(ROOT, base))) {
        const rel = relative(ROOT, file).split(sep).join('/')
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (isComment(line)) return
          for (const host of FORBIDDEN) {
            if (line.includes(host)) offences.push(`${rel}:${i + 1} -> ${host}`)
          }
        })
      }
    }
    expect(
      offences,
      'A public page must not fetch from a third party: it hands the reader\'s '
        + 'IP address to them, and the privacy policy says our subprocessor list '
        + 'is complete. Vendor the asset instead (see scripts/vendor-fonts.mjs), '
        + 'or update the privacy policy and the DPA before merging.',
    ).toEqual([])
  })

  // A guard that scans nothing passes forever.
  it('actually reads the renderers it claims to', () => {
    const files = PUBLIC_RENDERERS.flatMap((b) => sources(join(ROOT, b)))
    expect(files.length).toBeGreaterThan(10)
    expect(files.some((f) => f.includes('render.ts'))).toBe(true)
    expect(files.some((f) => f.includes('help.ts'))).toBe(true)
  })
})
