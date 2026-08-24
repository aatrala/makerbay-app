import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Fetch a page the user has pointed us at and reduce it to readable text.
 *
 * The server fetches URLs supplied by an untrusted caller, so the guard below
 * is the important part of this file: without it the endpoint is an SSRF proxy
 * into the private network and the cloud metadata service.
 */

const MAX_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5
const FETCH_TIMEOUT_MS = 15_000
export const USER_AGENT = 'MakerBayBot/1.0 (+https://makerbay.app; assistant knowledge)'

export interface ScrapedPage {
  url: string
  title: string
  text: string
  charCount: number
  warning?: 'looks_javascript_rendered'
}

/** True for addresses that must never be reachable from a user-supplied URL. */
function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    // Allowlist rather than blocklist: only global unicast (2000::/3) is
    // permitted. Blocklisting is too easy to slip past — an IPv4-mapped
    // address like ::ffff:127.0.0.1 is normalised by the URL parser to
    // ::ffff:7f00:1, which no dotted-quad pattern matches.
    const first = ip.toLowerCase().split(':')[0]
    if (!first) return true // leading "::" form — never global unicast
    const leading = Number.parseInt(first, 16)
    if (Number.isNaN(leading)) return true
    return leading < 0x2000 || leading > 0x3fff
  }
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
  if (p[0] === 192 && p[1] === 168) return true
  if (p[0] === 169 && p[1] === 254) return true // link-local, incl. metadata
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true // carrier NAT
  if (p[0] >= 224) return true // multicast / reserved
  return false
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('That does not look like a valid URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be fetched.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('That address is not publicly reachable.')
    return url
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('That address is not publicly reachable.')
  }
  const resolved = await lookup(host, { all: true }).catch(() => {
    throw new Error(`Could not resolve ${host}.`)
  })
  if (resolved.length === 0 || resolved.some((r) => isPrivateAddress(r.address))) {
    throw new Error('That address is not publicly reachable.')
  }
  return url
}

/** Fetch following redirects manually, re-checking every hop. */
async function safeFetch(raw: string, accept: string): Promise<{ url: string; body: string; contentType: string }> {
  let current = raw
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current)
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new Error(`The page redirected without a destination (${res.status}).`)
      current = new URL(location, url).toString()
      continue
    }
    if (!res.ok) throw new Error(`The page returned ${res.status}.`)

    const contentType = res.headers.get('content-type') ?? ''
    const reader = res.body?.getReader()
    if (!reader) return { url: url.toString(), body: '', contentType }

    // Read with a hard byte cap rather than trusting content-length.
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > MAX_BYTES) {
        void reader.cancel()
        break
      }
      chunks.push(value)
    }
    return {
      url: url.toString(),
      body: Buffer.concat(chunks).toString('utf8'),
      contentType,
    }
  }
  throw new Error('That page redirected too many times.')
}

/**
 * Minimal robots.txt handling: honour Disallow rules for `*` or our agent.
 * A tool that fetches any URL on demand should not ignore them, even when the
 * caller claims to own the site — we cannot verify that claim.
 */
export async function robotsAllows(target: URL): Promise<boolean> {
  try {
    const { body } = await safeFetch(new URL('/robots.txt', target).toString(), 'text/plain')
    const lines = body.split('\n').map((l) => l.replace(/#.*$/, '').trim())
    let applies = false
    const disallowed: string[] = []
    for (const line of lines) {
      const [rawKey, ...rest] = line.split(':')
      if (!rawKey || rest.length === 0) continue
      const key = rawKey.trim().toLowerCase()
      const value = rest.join(':').trim()
      if (key === 'user-agent') {
        applies = value === '*' || value.toLowerCase().includes('makerbay')
      } else if (key === 'disallow' && applies && value) {
        disallowed.push(value)
      }
    }
    return !disallowed.some((rule) => target.pathname.startsWith(rule))
  } catch {
    // No robots.txt, or it could not be read: nothing is disallowed.
    return true
  }
}

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))

/** Strip markup and boilerplate down to the readable content of a page. */
export function extractText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 200) : ''

  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')

  // Prefer the main content region when the page marks one.
  const main = body.match(/<(main|article)[^>]*>([\s\S]*?)<\/\1>/i)
  if (main) body = main[2]

  const text = decodeEntities(
    body
      .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return { title, text }
}

const looksLikeHtml = (body: string) => /<!doctype html|<html[\s>]/i.test(body.slice(0, 300))

/**
 * Docs sites often serve a markdown twin of each page (page.md, or content
 * negotiation on Accept: text/markdown). Worth one cheap try before telling
 * the owner their page is unreadable.
 */
async function markdownFallback(finalUrl: string): Promise<ScrapedPage | undefined> {
  const base = finalUrl.replace(/\/$/, '')
  for (const candidate of [`${base}.md`, `${base}/index.md`]) {
    try {
      const { url, body } = await safeFetch(candidate, 'text/markdown,text/plain;q=0.9')
      const text = body.trim()
      if (!looksLikeHtml(text) && text.length >= 200) {
        const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim()
        return { url, title: title || url, text, charCount: text.length }
      }
    } catch {
      // next candidate
    }
  }
  return undefined
}

/**
 * Next.js embeds the rendered page's data as JSON in __NEXT_DATA__. When the
 * visible HTML is an empty shell, the words are often all in there - pull out
 * the human-sized strings rather than declaring the page unreadable.
 */
export function nextDataText(html: string): string {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (!m) return ''
  try {
    const strings: string[] = []
    const walk = (v: unknown): void => {
      if (typeof v === 'string') {
        const s = v.trim()
        if (s.split(/\s+/).length >= 4 && !/^(https?:|\/|\{|\[)/.test(s)) strings.push(s)
      } else if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(JSON.parse(m[1]))
    return [...new Set(strings)].join('\n')
  } catch {
    return ''
  }
}

export async function scrapePage(rawUrl: string): Promise<ScrapedPage> {
  const url = await assertPublicUrl(rawUrl)
  if (!(await robotsAllows(url))) {
    throw new Error("This site's robots.txt asks automated tools not to fetch that page.")
  }

  const { url: finalUrl, body, contentType } = await safeFetch(url.toString(), 'text/html,text/plain;q=0.9,*/*;q=0.8')

  if ((contentType.includes('text/plain') || finalUrl.endsWith('.txt')) && !looksLikeHtml(body)) {
    const text = body.trim()
    return { url: finalUrl, title: finalUrl.split('/').pop() || finalUrl, text, charCount: text.length }
  }
  if (!contentType.includes('html') && !contentType.includes('text/plain') && contentType) {
    throw new Error(`That URL returned ${contentType.split(';')[0]}, which cannot be read as a web page yet.`)
  }

  const { title, text } = extractText(body)
  if (text.length >= 200) {
    return { url: finalUrl, title: title || finalUrl, text, charCount: text.length }
  }

  // The visible HTML is nearly empty - almost always a JavaScript-drawn page.
  // Two honest rescues before giving up: a markdown twin, then Next.js data.
  const md = await markdownFallback(finalUrl)
  if (md) return md

  const fromNextData = nextDataText(body)
  if (fromNextData.length >= 200) {
    return { url: finalUrl, title: title || finalUrl, text: fromNextData, charCount: fromNextData.length }
  }

  return {
    url: finalUrl,
    title: title || finalUrl,
    text,
    charCount: text.length,
    // Saying so beats storing an empty document silently.
    warning: 'looks_javascript_rendered',
  }
}

/**
 * Candidate pages for a site: sitemap.xml, plus /llms.txt when present, which
 * sites publish specifically for machine readers.
 */
export async function discoverPages(rawUrl: string, limit = 60): Promise<{ urls: string[]; source: string }> {
  const root = await assertPublicUrl(rawUrl)
  const origin = root.origin

  for (const path of ['/sitemap.xml', '/sitemap_index.xml']) {
    try {
      const { body } = await safeFetch(`${origin}${path}`, 'application/xml,text/xml')
      const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1])
      const pages = locs.filter((u) => u.startsWith(origin) && !/\.(xml|jpg|png|gif|pdf|zip)$/i.test(u))
      if (pages.length > 0) return { urls: [...new Set(pages)].slice(0, limit), source: path }
    } catch {
      // try the next candidate
    }
  }

  try {
    const { body } = await safeFetch(`${origin}/llms.txt`, 'text/plain')
    const links = [...body.matchAll(/\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1])
    const pages = links.filter((u) => u.startsWith(origin))
    if (pages.length > 0) {
      // llms.txt itself is written for machine readers and is often the best
      // single document on the site - offer it first, ahead of its links.
      return { urls: [...new Set([`${origin}/llms.txt`, ...pages])].slice(0, limit), source: '/llms.txt' }
    }
  } catch {
    // fall through
  }

  // Nothing machine-readable: offer same-origin links from the page itself.
  const { body } = await safeFetch(root.toString(), 'text/html')
  const hrefs = [...body.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)].map((m) => m[1])
  const pages = hrefs
    .map((h) => {
      try { return new URL(h, root).toString() } catch { return '' }
    })
    .filter((u) => u.startsWith(origin) && !/\.(jpg|png|gif|pdf|zip|css|js)$/i.test(u))
  return { urls: [...new Set(pages)].slice(0, limit), source: 'page links' }
}
