import { randomBytes } from 'node:crypto'

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Compact ULID: 10-char Crockford-base32 timestamp + 16 random chars. */
export function ulid(now = Date.now()): string {
  let t = now
  const time: string[] = new Array(10)
  for (let i = 9; i >= 0; i--) {
    time[i] = B32[t % 32]
    t = Math.floor(t / 32)
  }
  const rand = Array.from(randomBytes(16), (b) => B32[b & 31])
  return time.join('') + rand.join('')
}

/** A clean URL-safe base from a business name: "Smith Plumbing" → "smith-plumbing". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

/**
 * Candidate slugs in the order a person would want them: the clean name
 * first, then readable suffixes, then numbers. The old scheme appended three
 * random base32 characters to every slug, which nobody could remember or
 * read out over the phone.
 */
export function slugCandidates(name: string): string[] {
  const base = slugify(name) || `workspace-${Array.from(randomBytes(2), (b) => B32[b & 31].toLowerCase()).join('')}`
  const out = [base]
  for (const word of ['co', 'hq', 'au', 'team', 'group']) out.push(`${base}-${word}`)
  for (let n = 2; n <= 20; n++) out.push(`${base}-${n}`)
  return out
}

/**
 * Names a tenant slug may never take: our own subdomains, app routes, and
 * words that would let a workspace impersonate the platform.
 */
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'assets', 'billing', 'blog', 'booking', 'chat',
  'changelog', 'contact', 'demo', 'docs', 'embed', 'help', 'invoice', 'legal',
  'login', 'mail', 'makerbay', 'mcp', 'modules', 'p', 'pricing', 'privacy',
  'quote', 'review', 'roadmap', 'root', 'signup', 'sitemap', 'static',
  'status', 'stream', 'support', 'terms', 'test', 'widget', 'www',
])

/** Format + reservation check. Availability against the table is the caller's job. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(slug) && !/--/.test(slug) && !RESERVED_SLUGS.has(slug)
}
