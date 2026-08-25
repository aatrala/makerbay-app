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
  // A generated title (made at publish time) beats any filename cleanup.
  if (source.helpMeta?.title) return source.helpMeta.title
  const raw = source.name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/^Q&A:\s*/, '').trim()
  if (!raw) return 'Untitled'
  // Names with spaces were written by a person; leave those alone.
  if (/\s/.test(raw)) return raw
  const spaced = raw.replace(/[-_]+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// ── Shared chrome ────────────────────────────────────────────────────────

const styles = (brand: string) => `
  :root { --brand: ${esc(brand)}; --ink: #1c1917; --body: #57534e; --muted: #a8a29e;
    --line: #e7e5e4; --soft: #faf9f7; --card: #ffffff; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', sans-serif;
    color: var(--ink); background: var(--soft); line-height: 1.65; font-size: 17px; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 0 24px; }
  header { background: var(--card); border-bottom: 1px solid var(--line); padding: 16px 0; }
  header .wrap { display: flex; align-items: center; gap: 16px; }
  header a.home { font-weight: 700; font-size: 17px; color: var(--ink); text-decoration: none;
    letter-spacing: -0.02em; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header .btn { padding: 8px 16px; font-size: 14px; }
  a { color: var(--brand); }
  .hero { padding: 44px 0 34px; }
  h1 { font-size: clamp(28px, 4vw, 40px); line-height: 1.15; letter-spacing: -0.02em; margin-bottom: 10px; }
  p { color: var(--body); margin-bottom: 14px; }
  .lead { font-size: 18.5px; margin-bottom: 0; max-width: 56ch; }
  .search { margin: 22px 0 0; position: relative; max-width: 480px; }
  .search input { width: 100%; padding: 13px 18px; border: 1px solid var(--line); border-radius: 12px;
    font: inherit; font-size: 16px; background: var(--card); outline: none; }
  .search input:focus { border-color: var(--brand); }
  .cat { margin: 30px 0 0; }
  .cat > h2 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted);
    margin: 0 0 10px 2px; }
  ul.articles { list-style: none; display: grid; gap: 10px; }
  ul.articles a { display: block; padding: 16px 20px; text-decoration: none; color: inherit;
    background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
  ul.articles a:hover { border-color: var(--brand); }
  ul.articles a:hover h3 { color: var(--brand); }
  ul.articles h3 { margin: 0 0 3px; font-size: 17px; letter-spacing: -0.01em; }
  ul.articles p { margin: 0; font-size: 14.5px; color: var(--muted); }
  .none { display: none; }
  .no-results { color: var(--muted); padding: 20px 2px; }
  .article-wrap { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
    padding: 34px 34px 28px; margin-top: 28px; }
  article { white-space: pre-wrap; font-size: 16.5px; color: var(--body); }
  .meta { color: var(--muted); font-size: 14px; margin-bottom: 20px; }
  .crumb { display: inline-block; margin: 26px 0 0; font-size: 14.5px; text-decoration: none; font-weight: 600; }
  .ask { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
    padding: 22px 24px; margin: 36px 0; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .ask div { flex: 1; min-width: 200px; }
  .ask h2 { margin: 0 0 4px; font-size: 17px; }
  .ask p { margin: 0; font-size: 14.5px; }
  .btn { display: inline-block; background: var(--brand); color: #fff; text-decoration: none;
    padding: 11px 20px; border-radius: 9px; font-weight: 650; font-size: 15px; white-space: nowrap; }
  footer { border-top: 1px solid var(--line); margin-top: 40px; padding: 26px 0 44px; }
  footer p { font-size: 14px; color: var(--muted); margin: 0; }
  @media (max-width: 560px) { .article-wrap { padding: 22px 18px; } }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #f5f5f4; --body: #d6d3d1; --muted: #a8a29e; --line: #33302c;
      --soft: #1c1917; --card: #262220; }
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
    <a class="btn" href="https://chat.makerbay.app/${esc(opts.slug)}">Ask a question</a>
  </div>
</header>
<main class="wrap">
${opts.body}
</main>
<footer>
  <div class="wrap"><p>Help centre powered by <a href="https://makerbay.app">MakerBay</a></p></div>
</footer>
${
  // The assistant answers right here instead of bouncing the reader to a
  // separate chat page (issue 67). The links keep their hrefs so a crawler
  // or no-JavaScript reader still lands somewhere useful.
  opts.slug
    ? `<script src="https://widget.makerbay.app/widget.js" data-slug="${esc(opts.slug)}" data-color="${esc(opts.brand)}" defer></script>
<script>
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest ? e.target.closest('a') : null
  if (!a || (a.href || '').indexOf('chat.makerbay.app') === -1) return
  var b = document.querySelector('button[aria-label="Open chat"], button[aria-label="Close chat"]')
  if (!b) return
  e.preventDefault()
  if (b.getAttribute('aria-label') === 'Open chat') b.click()
})
</script>`
    : ''
}
</body>
</html>
`

const askBlock = (slug: string, assistantName: string) => `
<div class="ask">
  <div>
    <h2>Cannot find what you need?</h2>
    <p>Ask ${esc(assistantName)} directly - it answers from these same documents, instantly.</p>
  </div>
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

/** Category display order; anything unrecognised lands in General. */
const CATEGORY_ORDER = [
  'Getting started',
  'Services & pricing',
  'Bookings & appointments',
  'Policies & guarantees',
  'Troubleshooting',
  'General',
]

export function renderIndex(
  config: AssistantConfigRow & { helpTitle?: string; helpIntro?: string },
  slug: string,
  sources: SourceRow[],
  excerpts: Record<string, string>,
): APIGatewayProxyResultV2 {
  const siteName = config.helpTitle?.trim() || `${config.name} help centre`
  const intro = config.helpIntro?.trim() || 'Straight answers about our services, prices and how we work.'

  const describe = (s: SourceRow): string =>
    s.helpMeta?.description ??
    `${(excerpts[s.sourceId] ?? '').slice(0, 150)}${(excerpts[s.sourceId] ?? '').length > 150 ? '…' : ''}`

  // Group by generated category. A single-category centre skips the group
  // headings - structure should only appear once it structures something.
  const groups = new Map<string, SourceRow[]>()
  for (const s of sources) {
    const cat = s.helpMeta?.category && CATEGORY_ORDER.includes(s.helpMeta.category)
      ? s.helpMeta.category
      : 'General'
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(s)
  }
  const orderedCats = CATEGORY_ORDER.filter((c) => groups.has(c))
  const showHeadings = orderedCats.length > 1

  const item = (s: SourceRow) => `    <li data-t="${esc((titleOf(s) + ' ' + describe(s)).toLowerCase())}"><a href="/${esc(slug)}/${esc(articleSlug(s))}">
      <h3>${esc(titleOf(s))}</h3>
      <p>${esc(describe(s))}</p>
    </a></li>`

  const list = sources.length
    ? orderedCats
        .map(
          (cat) => `<section class="cat" data-cat>
  ${showHeadings ? `<h2>${esc(cat)}</h2>` : ''}
  <ul class="articles">
${groups.get(cat)!.map(item).join('\n')}
  </ul>
</section>`,
        )
        .join('\n')
    : '<p>No articles have been published yet.</p>'

  // Search filters what is already on the page - honest, instant, and the
  // full list stays served for the no-JavaScript reader and the crawler.
  const search = sources.length > 3
    ? `<div class="search"><input id="q" type="search" placeholder="Search ${sources.length} articles…" aria-label="Search articles" /></div>
<p class="no-results none" id="noq">Nothing matches that. Try the Ask a question button instead.</p>
<script>
(function () {
  var q = document.getElementById('q')
  if (!q) return
  q.addEventListener('input', function () {
    var t = q.value.trim().toLowerCase()
    var any = false
    document.querySelectorAll('ul.articles li').forEach(function (li) {
      var hit = !t || (li.getAttribute('data-t') || '').indexOf(t) !== -1
      li.classList.toggle('none', !hit)
      if (hit) any = true
    })
    document.querySelectorAll('[data-cat]').forEach(function (sec) {
      var visible = sec.querySelectorAll('li:not(.none)').length > 0
      sec.classList.toggle('none', !visible)
    })
    document.getElementById('noq').classList.toggle('none', any)
  })
})()
</script>`
    : ''

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
      body: `<div class="hero">
<h1>${esc(siteName)}</h1>
<p class="lead">${esc(intro)}</p>
${search}
</div>
${list}
${askBlock(slug, config.name)}`,
    }),
    // The index is where a fresh publish shows up; cache it lightly so the
    // owner sees their change in about a minute, not five (issue 65).
    60,
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
      body: `<a class="crumb" href="/${esc(slug)}">&larr; All articles</a>
<div class="article-wrap">
<h1>${esc(title)}</h1>
<p class="meta">${source.helpMeta?.category ? `${esc(source.helpMeta.category)} · ` : ''}Updated <time datetime="${esc(updated)}">${esc(new Date(updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}</time></p>
<article>${esc(text)}</article>
</div>
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
