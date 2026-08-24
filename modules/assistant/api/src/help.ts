/**
 * Public help centre. Renders real HTML on the server rather than shipping a
 * client-side app: the whole point is that Google indexes these pages, and a
 * page that needs JavaScript to show its text indexes badly.
 *
 * Nothing is published by accident. A workspace has to switch the help centre
 * on, and then publish each source individually - their documents are private
 * until they say otherwise.
 */

import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import type { AssistantConfigRow, SourceRow } from './db'

const esc = (s: string): string =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const html = (statusCode: number, body: string, maxAgeSeconds = 300): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': `public, max-age=60, s-maxage=${maxAgeSeconds}`,
    'x-content-type-options': 'nosniff',
    // The help centre is the tenant's content on our domain; deny framing.
    'content-security-policy': "frame-ancestors 'none'",
  },
  body,
})

export const HELP_ORIGIN = 'https://help.makerbay.app'

/** A stable, readable URL segment. Falls back to the id when the name is unusable. */
export const articleSlug = (source: Pick<SourceRow, 'sourceId' | 'name'>): string => {
  const base = source.name
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  // The id stays in the slug so lookups never need a second index.
  return base ? `${base}-${source.sourceId}` : source.sourceId
}

export const sourceIdFromSlug = (slug: string): string => {
  const m = slug.match(/([0-9A-Z]{26})$/)
  return m ? m[1] : slug
}

/**
 * A filename is not a headline. Strip the extension, turn separators back
 * into spaces, and capitalise - a public page should not read as "faq-v2.pdf".
 */
const titleOf = (source: SourceRow): string => {
  const raw = source.name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/^Q&A:\s*/, '').trim()
  if (!raw) return 'Untitled'
  // Names with spaces were written by a person; leave those alone.
  if (/\s/.test(raw)) return raw
  const spaced = raw.replace(/[-_]+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// ── Shared chrome ────────────────────────────────────────────────────────

const styles = (brand: string) => `
  :root { --brand: ${esc(brand)}; --ink: #1c1917; --body: #57534e; --muted: #a8a29e; --line: #e7e5e4; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', sans-serif;
    color: var(--ink); background: #fff; line-height: 1.65; font-size: 17px; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 24px; }
  header { border-bottom: 1px solid var(--line); padding: 22px 0; margin-bottom: 40px; }
  header .wrap { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header a.home { font-weight: 700; font-size: 18px; color: var(--ink); text-decoration: none; letter-spacing: -0.02em; }
  a { color: var(--brand); }
  h1 { font-size: clamp(28px, 4vw, 38px); line-height: 1.2; letter-spacing: -0.02em; margin-bottom: 12px; }
  h2 { font-size: 20px; margin: 32px 0 8px; letter-spacing: -0.01em; }
  p { color: var(--body); margin-bottom: 14px; }
  .lead { font-size: 19px; margin-bottom: 32px; }
  ul.articles { list-style: none; margin: 24px 0; }
  ul.articles li { border-bottom: 1px solid var(--line); }
  ul.articles li:last-child { border-bottom: none; }
  ul.articles a { display: block; padding: 18px 0; text-decoration: none; color: inherit; }
  ul.articles a:hover h2 { color: var(--brand); }
  ul.articles h2 { margin: 0 0 4px; font-size: 18px; }
  ul.articles p { margin: 0; font-size: 15.5px; color: var(--muted); }
  article { white-space: pre-wrap; font-size: 16.5px; color: var(--body); }
  .meta { color: var(--muted); font-size: 14.5px; }
  .back { display: inline-block; margin-bottom: 24px; font-size: 15px; text-decoration: none; }
  .ask { border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin: 44px 0; }
  .ask h2 { margin-top: 0; }
  .btn { display: inline-block; background: var(--brand); color: #fff; text-decoration: none;
    padding: 11px 20px; border-radius: 8px; font-weight: 650; font-size: 15px; }
  footer { border-top: 1px solid var(--line); margin-top: 56px; padding: 28px 0 44px; }
  footer p { font-size: 14px; color: var(--muted); margin: 0; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #f5f5f4; --body: #d6d3d1; --muted: #a8a29e; --line: #292524; }
    body { background: #1c1917; }
    header a.home { color: var(--ink); }
  }
`

const chrome = (opts: {
  title: string
  description: string
  canonical: string
  brand: string
  siteName: string
  slug: string
  body: string
  noindex?: boolean
}): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}" />
${opts.noindex ? '<meta name="robots" content="noindex" />' : ''}
<link rel="canonical" href="${esc(opts.canonical)}" />
<meta property="og:title" content="${esc(opts.title)}" />
<meta property="og:description" content="${esc(opts.description)}" />
<meta property="og:url" content="${esc(opts.canonical)}" />
<meta property="og:type" content="article" />
<style>${styles(opts.brand)}</style>
</head>
<body>
<header>
  <div class="wrap">
    <a class="home" href="/${esc(opts.slug)}">${esc(opts.siteName)}</a>
  </div>
</header>
<main class="wrap">
${opts.body}
</main>
<footer>
  <div class="wrap"><p>Help centre powered by <a href="https://makerbay.app">MakerBay</a></p></div>
</footer>
</body>
</html>
`

const askBlock = (slug: string, assistantName: string) => `
<div class="ask">
  <h2>Cannot find what you need?</h2>
  <p>Ask ${esc(assistantName)} directly. It answers from these same documents.</p>
  <a class="btn" href="https://chat.makerbay.app/${esc(slug)}">Ask a question</a>
</div>`

// ── Pages ────────────────────────────────────────────────────────────────

export function renderNotFound(): APIGatewayProxyResultV2 {
  return html(
    404,
    chrome({
      title: 'Help centre not found',
      description: 'This help centre does not exist or has not been published.',
      canonical: HELP_ORIGIN,
      brand: '#c2410c',
      siteName: 'MakerBay',
      slug: '',
      noindex: true,
      body: '<h1>Nothing here</h1><p>This help centre does not exist, or has not been published yet.</p>',
    }),
    60,
  )
}

export function renderIndex(
  config: AssistantConfigRow & { helpTitle?: string; helpIntro?: string },
  slug: string,
  sources: SourceRow[],
  excerpts: Record<string, string>,
): APIGatewayProxyResultV2 {
  const siteName = config.helpTitle?.trim() || `${config.name} help centre`
  const intro = config.helpIntro?.trim() || 'Answers to the questions we are asked most often.'

  const list = sources.length
    ? `<ul class="articles">
${sources
  .map(
    (s) => `  <li><a href="/${esc(slug)}/${esc(articleSlug(s))}">
    <h2>${esc(titleOf(s))}</h2>
    <p>${esc((excerpts[s.sourceId] ?? '').slice(0, 150))}${(excerpts[s.sourceId] ?? '').length > 150 ? '…' : ''}</p>
  </a></li>`,
  )
  .join('\n')}
</ul>`
    : '<p>No articles have been published yet.</p>'

  return html(
    200,
    chrome({
      title: siteName,
      description: intro,
      canonical: `${HELP_ORIGIN}/${slug}`,
      brand: config.brandColor,
      siteName,
      slug,
      // An empty help centre should not be indexed as a thin page.
      noindex: sources.length === 0,
      body: `<h1>${esc(siteName)}</h1>
<p class="lead">${esc(intro)}</p>
${list}
${askBlock(slug, config.name)}`,
    }),
  )
}

export function renderArticle(
  config: AssistantConfigRow & { helpTitle?: string },
  slug: string,
  source: SourceRow,
  text: string,
): APIGatewayProxyResultV2 {
  const siteName = config.helpTitle?.trim() || `${config.name} help centre`
  const title = titleOf(source)
  const updated = source.fetchedAt ?? source.updatedAt
  const description = text.replace(/\s+/g, ' ').slice(0, 300)

  return html(
    200,
    chrome({
      title: `${title} - ${siteName}`,
      description,
      canonical: `${HELP_ORIGIN}/${slug}/${articleSlug(source)}`,
      brand: config.brandColor,
      siteName,
      slug,
      body: `<a class="back" href="/${esc(slug)}">&larr; All articles</a>
<h1>${esc(title)}</h1>
<p class="meta">Updated <time datetime="${esc(updated)}">${esc(new Date(updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}</time></p>
<article>${esc(text)}</article>
${askBlock(slug, config.name)}`,
    }),
  )
}

/** Per-workspace sitemap, so a help centre can be submitted to Search Console. */
export function renderSitemap(slug: string, sources: SourceRow[]): APIGatewayProxyResultV2 {
  const urls = [
    `  <url><loc>${HELP_ORIGIN}/${slug}</loc></url>`,
    ...sources.map(
      (s) =>
        `  <url><loc>${HELP_ORIGIN}/${slug}/${articleSlug(s)}</loc><lastmod>${(s.fetchedAt ?? s.updatedAt).slice(0, 10)}</lastmod></url>`,
    ),
  ]
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300, s-maxage=3600' },
    body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`,
  }
}

export function renderRobots(slug?: string): APIGatewayProxyResultV2 {
  const body = slug
    ? `User-agent: *\nAllow: /\nSitemap: ${HELP_ORIGIN}/${slug}/sitemap.xml\n`
    : 'User-agent: *\nAllow: /\n'
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    body,
  }
}
