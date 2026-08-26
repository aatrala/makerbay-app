/**
 * Public help centre. Renders real HTML on the server rather than shipping a
 * client-side app: the whole point is that Google indexes these pages, and a
 * page that needs JavaScript to show its text indexes badly.
 *
 * Nothing is published by accident. A workspace has to switch the help centre
 * on, and then publish each source individually - their documents are private
 * until they say otherwise.
 *
 * v2 (spec-help-themes.md): five selectable themes on one renderer, popular
 * strip, escalation with the business's phone, related articles, "was this
 * helpful", formatted article bodies, breadcrumb + Article JSON-LD.
 */

import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { readableOn, shade, tint } from '@makerbay/core/color'
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
const API_ORIGIN = 'https://api.makerbay.app'

export type HelpTheme = 'clean' | 'bold' | 'editorial' | 'ledger' | 'signwriter'
export const HELP_THEMES: HelpTheme[] = ['clean', 'bold', 'editorial', 'ledger', 'signwriter']

/** Everything the renderer needs beyond the assistant config itself. */
export interface HelpRenderOpts {
  tier: 'free' | 'trade' | 'genie'
  phone?: string
  email?: string
  logoUrl?: string
  /** Genie second accent (callouts and small highlights). */
  accent2?: string
}

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

const GOOGLE_FONT_RE = /^[A-Za-z0-9 ]{2,40}$/

// ── Theme definitions ────────────────────────────────────────────────────

interface ThemeDef {
  fontHref?: string
  headFont: string
  bodyFont: string
}

const THEME_FONTS: Record<HelpTheme, ThemeDef> = {
  clean: {
    headFont: "'Segoe UI', system-ui, -apple-system, sans-serif",
    bodyFont: "'Segoe UI', system-ui, -apple-system, sans-serif",
  },
  bold: {
    fontHref: 'https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;800&display=swap',
    headFont: "'Archivo', 'Segoe UI', sans-serif",
    bodyFont: "'Archivo', 'Segoe UI', sans-serif",
  },
  editorial: {
    fontHref:
      'https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,500;8..60,600&family=Source+Sans+3:wght@400;600&display=swap',
    headFont: "'Source Serif 4', Georgia, serif",
    bodyFont: "'Source Sans 3', 'Segoe UI', sans-serif",
  },
  ledger: {
    fontHref:
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap',
    headFont: "'IBM Plex Sans', 'Segoe UI', sans-serif",
    bodyFont: "'IBM Plex Sans', 'Segoe UI', sans-serif",
  },
  signwriter: {
    fontHref:
      'https://fonts.googleapis.com/css2?family=Zilla+Slab:wght@500;600&family=Public+Sans:wght@400;600;700&display=swap',
    headFont: "'Zilla Slab', Georgia, serif",
    bodyFont: "'Public Sans', 'Segoe UI', sans-serif",
  },
}

export const resolveTheme = (config: AssistantConfigRow, tier: HelpRenderOpts['tier']): HelpTheme => {
  const t = (config.helpTheme ?? 'clean') as HelpTheme
  if (!HELP_THEMES.includes(t)) return 'clean'
  // A theme kept after a downgrade silently falls back rather than 402s the
  // public page - visitors never see a tier problem.
  if (t !== 'clean' && tier === 'free') return 'clean'
  return t
}

// ── Stylesheet ───────────────────────────────────────────────────────────

const styles = (theme: HelpTheme, brand: string, opts: HelpRenderOpts, fontHeadOverride?: string): string => {
  const def = THEME_FONTS[theme]
  const headFont =
    opts.tier === 'genie' && fontHeadOverride && GOOGLE_FONT_RE.test(fontHeadOverride)
      ? `'${fontHeadOverride}', ${def.headFont}`
      : def.headFont
  const dark = shade(brand, 0.42)
  const darker = shade(brand, 0.62)
  const onBrand = readableOn(brand)
  const onDark = readableOn(dark)
  const brandLine = tint(brand, 0.55)
  const accent2 = opts.tier === 'genie' && /^#[0-9a-fA-F]{6}$/.test(opts.accent2 ?? '') ? opts.accent2! : brand

  const base = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ${def.bodyFont}; line-height: 1.65; font-size: 16.5px; -webkit-font-smoothing: antialiased; }
  h1, h2, h3, .band b { font-family: ${headFont}; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 0 24px; }
  a { text-decoration: none; }
  header .home { font-weight: 700; font-size: 17px; flex: 1; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 10px; }
  header img.logo { height: 30px; width: auto; border-radius: 7px; }
  .hero { padding: 40px 0 30px; }
  h1 { font-size: clamp(27px, 4vw, 38px); line-height: 1.14; letter-spacing: -0.02em; }
  .lead { font-size: 18px; margin-top: 8px; max-width: 56ch; }
  .search { margin: 20px 0 0; position: relative; max-width: 480px; }
  .search input { width: 100%; padding: 12px 17px; font: inherit; font-size: 15.5px; outline: none; }
  .pop { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: center; margin-top: 16px; }
  .pop .plabel { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; }
  .cat { margin: 26px 0 0; }
  .cat > h2 { margin-bottom: 10px; }
  .arti { display: block; }
  .arti h3 { margin: 0 0 3px; font-size: 16.5px; letter-spacing: -0.01em; }
  .arti p { margin: 0; font-size: 14px; }
  .none { display: none; }
  .no-results { padding: 20px 2px; }
  .meta { font-size: 13.5px; margin-bottom: 18px; }
  .crumb { display: inline-block; margin: 24px 0 0; font-size: 14px; font-weight: 600; }
  .artbody p { margin-bottom: 13px; }
  .artbody ul, .artbody ol { margin: 0 0 13px 22px; }
  .artbody li { margin-bottom: 4px; }
  .step { display: flex; align-items: center; gap: 11px; margin: 20px 0 9px; }
  .step .n { width: 27px; height: 27px; border-radius: 50%; background: ${brand}; color: ${onBrand};
    display: flex; align-items: center; justify-content: center; font-size: 13.5px; font-weight: 700; flex: none; }
  .step h2 { font-size: 19px; }
  .h2p { margin: 20px 0 9px; font-size: 19px; }
  .callout { border-left: 3px solid ${accent2}; background: ${tint(accent2, 0.9)}; color: inherit;
    padding: 10px 15px; margin: 15px 0; border-radius: 0 8px 8px 0; font-size: 14.5px; }
  .callout.warn { border-left-color: #b45309; background: #fef3e2; }
  .callout b { color: ${shade(accent2, 0.15)}; }
  .callout.warn b { color: #92400e; }
  .rel { margin-top: 20px; padding-top: 13px; font-size: 14px; }
  .rel .rlabel { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; margin-right: 8px; }
  .rel a { margin-right: 14px; font-weight: 600; }
  .hlp { margin-top: 13px; font-size: 13.5px; }
  .hlp button { font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; margin-left: 6px;
    border-radius: 8px; padding: 4px 13px; background: transparent; }
  .ask { border-radius: 14px; padding: 20px 22px; margin: 32px 0 0; display: flex; gap: 16px;
    align-items: center; flex-wrap: wrap; }
  .ask > div { flex: 1; min-width: 220px; }
  .ask h2 { margin: 0 0 4px; font-size: 17px; }
  .ask p { margin: 0; font-size: 14px; }
  .btn { display: inline-block; padding: 10px 19px; border-radius: 9px; font-weight: 650; font-size: 14.5px; white-space: nowrap; }
  footer { margin-top: 40px; padding: 24px 0 42px; }
  footer p { font-size: 13.5px; margin: 0; }
  @media (max-width: 560px) { .hero { padding: 30px 0 22px; } }
`

  if (theme === 'clean')
    return base + `
  body { color: #1c1917; background: #faf9f7; }
  header { background: #fff; border-bottom: 1px solid #e7e5e4; border-top: 3px solid ${brand}; padding: 13px 0; }
  header .wrap { display: flex; align-items: center; gap: 16px; }
  header .home { color: #1c1917; }
  a { color: ${brand}; }
  .lead, .artbody p, .artbody li { color: #57534e; }
  .search input { border: 1px solid #e7e5e4; border-radius: 12px; background: #fff; }
  .search input:focus { border-color: ${brand}; }
  .pop .plabel { color: #78716c; }
  .pop a { background: #fff; border: 1px solid #e7e5e4; border-radius: 999px; padding: 5px 13px;
    font-size: 13px; font-weight: 600; color: #44403c; }
  .pop a:hover { border-color: ${brand}; color: ${brand}; }
  .cat > h2 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .08em; color: #78716c; }
  .cat > h2 span { color: #a8a29e; }
  ul.articles { list-style: none; display: grid; gap: 10px; }
  .arti { padding: 15px 19px; color: inherit; background: #fff; border: 1px solid #e7e5e4;
    border-radius: 12px; transition: border-color .12s, transform .12s; }
  .arti:hover { border-color: ${brandLine}; transform: translateY(-1px); }
  .arti:hover h3 { color: ${brand}; }
  .arti h3 { color: #1c1917; }
  .arti p { color: #78716c; }
  .no-results, .meta { color: #78716c; }
  .artwrap { background: #fff; border: 1px solid #e7e5e4; border-radius: 14px; padding: 32px 32px 26px; margin-top: 14px; }
  .artbody.raw { white-space: pre-wrap; font-size: 15.5px; }
  .rel { border-top: 1px solid #e7e5e4; }
  .rel .rlabel { color: #78716c; }
  .hlp { color: #78716c; }
  .hlp button { border: 1px solid #d6d3d1; color: #1c1917; }
  .hlp button:hover { border-color: ${brand}; color: ${brand}; }
  .ask { background: #fff; border: 1px solid #e7e5e4; }
  .ask p { color: #57534e; }
  .btn { background: ${brand}; color: ${onBrand}; }
  footer { border-top: 1px solid #e7e5e4; }
  footer p { color: #78716c; }
  footer b { color: #57534e; }
  @media (max-width: 560px) { .artwrap { padding: 22px 18px; } }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1917; color: #f5f5f4; }
    header, .arti, .artwrap, .ask, .pop a, .search input { background: #262220; border-color: #33302c; }
    header .home, .arti h3, .pop a, .hlp button { color: #f5f5f4; }
    .lead, .artbody p, .artbody li, .ask p { color: #d6d3d1; }
    .callout { background: #2c2523; }
    .rel, footer { border-color: #33302c; }
  }
`

  if (theme === 'bold')
    return base + `
  body { color: #221a1c; background: ${tint(brand, 0.93)}; }
  header { background: ${dark}; padding: 13px 0; }
  header .wrap { display: flex; align-items: center; gap: 16px; }
  header .home { color: ${onDark}; font-weight: 800; }
  a { color: ${shade(brand, 0.1)}; }
  .hero { background: ${brand}; padding: 34px 0 52px; }
  .hero h1, .hero .lead { color: ${onBrand}; }
  .hero .lead { opacity: .88; }
  .heroin + main .search { margin-top: -26px; }
  .search input { background: #fff; border: 1.5px solid ${darker}; border-radius: 10px; color: #221a1c;
    box-shadow: 0 6px 18px rgba(0,0,0,.16); }
  .pop { margin-top: 20px; }
  .pop .plabel { color: ${shade(brand, 0.3)}; }
  .pop a { background: ${tint(brand, 0.82)}; color: ${shade(brand, 0.2)}; border-radius: 8px;
    padding: 5px 13px; font-size: 13px; font-weight: 700; }
  .pop a:hover { background: ${brand}; color: ${onBrand}; }
  .cat > h2 { display: inline-block; background: ${brand}; color: ${onBrand}; font-size: 12px;
    font-weight: 700; text-transform: uppercase; letter-spacing: .07em; padding: 4px 12px; border-radius: 6px; }
  .cat > h2 span { opacity: .75; }
  ul.articles { list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
  .arti { background: #fff; border: 1.5px solid ${tint(dark, 0.35)}; border-radius: 10px; padding: 14px 17px;
    color: inherit; transition: border-color .12s, transform .12s; }
  .arti:hover { border-color: ${brand}; transform: translateY(-2px); }
  .arti h3 { color: #221a1c; font-weight: 700; }
  .arti p { color: ${shade(tint(brand, 0.3), 0.45)}; font-size: 13px; }
  .no-results, .meta { color: ${shade(tint(brand, 0.3), 0.45)}; }
  .artwrap { background: #fff; border: 1.5px solid ${tint(dark, 0.35)}; border-radius: 12px; padding: 30px 30px 24px; margin-top: 14px; }
  .artbody p, .artbody li { color: #453d40; }
  .artbody h1 { font-weight: 800; }
  .artbody.raw { white-space: pre-wrap; font-size: 15.5px; }
  .rel { border-top: 1.5px solid ${tint(dark, 0.65)}; }
  .rel .rlabel { color: ${shade(tint(brand, 0.3), 0.45)}; }
  .hlp { color: ${shade(tint(brand, 0.3), 0.45)}; }
  .hlp button { border: 1.5px solid ${tint(dark, 0.35)}; color: #221a1c; }
  .hlp button:hover { border-color: ${brand}; color: ${brand}; }
  .ask { background: ${dark}; }
  .ask h2 { color: ${onDark}; }
  .ask p { color: ${onDark}; opacity: .85; }
  .ask .btn { background: #fff; color: ${shade(brand, 0.1)}; }
  .btn { background: #fff; color: ${shade(brand, 0.1)}; font-weight: 700; }
  header .btn { padding: 8px 15px; font-size: 13.5px; }
  footer { border-top: 1.5px solid ${tint(dark, 0.65)}; }
  footer p { color: ${shade(tint(brand, 0.3), 0.45)}; }
  footer b { color: ${shade(brand, 0.1)}; }
  @media (max-width: 560px) { .artwrap { padding: 22px 18px; } }
`

  if (theme === 'editorial')
    return base + `
  body { color: #262023; background: #f7f6f3; }
  header { background: #f7f6f3; border-bottom: 1px solid #262023; padding: 14px 0; }
  header .wrap { display: flex; align-items: center; gap: 16px; }
  header .home { color: #262023; font-weight: 600; }
  a { color: ${brand}; }
  .lead { color: #5d5458; }
  .search input { border: none; border-bottom: 1px solid #262023; background: transparent; border-radius: 0; padding: 8px 2px; }
  .pop .plabel { color: ${brand}; letter-spacing: .14em; }
  .pop a { color: #262023; border-bottom: 1px solid #cfc7bf; font-size: 14px; }
  .pop a:hover { color: ${brand}; border-color: ${brand}; }
  .cat > h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .14em; color: ${brand}; margin-bottom: 4px; }
  .cat > h2 span { color: #766c70; letter-spacing: .04em; }
  ul.articles { list-style: none; }
  .arti { padding: 12px 2px; border-bottom: 1px solid #ded9d0; color: inherit; }
  .arti:hover h3 { color: ${brand}; }
  .arti h3 { color: #262023; font-weight: 500; font-size: 17.5px; }
  .arti p { color: #5d5458; font-size: 13.5px; }
  .no-results, .meta { color: #766c70; }
  .artwrap { margin-top: 16px; }
  .artbody p, .artbody li { color: #453d41; max-width: 64ch; }
  .artbody .lede { font-family: ${headFont}; font-size: 18.5px; color: #262023; }
  .artbody.raw { white-space: pre-wrap; font-size: 15.5px; }
  .step .n { background: transparent; border: 1px solid ${brand}; color: ${brand}; }
  .rel { border-top: 1px solid #ded9d0; }
  .rel .rlabel { color: ${brand}; letter-spacing: .14em; }
  .rel a { color: #262023; border-bottom: 1px solid #cfc7bf; font-weight: 400; }
  .hlp { color: #5d5458; }
  .hlp button { border: 1px solid #a99fa2; border-radius: 999px; color: #262023; }
  .hlp button:hover { border-color: ${brand}; color: ${brand}; }
  .ask { border-top: 1px solid #262023; border-radius: 0; padding: 18px 0 0; background: transparent; }
  .ask p { color: #5d5458; }
  .btn { color: ${brand}; border: 1px solid ${brand}; border-radius: 999px; padding: 7px 15px; font-size: 13.5px; background: transparent; }
  .btn:hover { background: ${brand}; color: ${readableOn(brand)}; }
  footer { border-top: 1px solid #ded9d0; }
  footer p { color: #766c70; }
  footer b { color: #453d41; }
`

  if (theme === 'ledger')
    return base + `
  body { color: #1a1d21; background: #ffffff; }
  .mono, .meta, .arti .dt, .pop .plabel, .cat > h2 { font-family: 'IBM Plex Mono', Consolas, monospace; }
  header { border-bottom: 1px solid #d9dde3; padding: 13px 0; }
  header .wrap { display: flex; align-items: center; gap: 16px; }
  header .home { color: #1a1d21; font-weight: 600; }
  a { color: ${brand}; }
  .lead { color: #454c55; font-size: 15.5px; }
  .search input { border: 1px solid #b8bfc9; border-radius: 8px; background: #fff; }
  .search input:focus { border-color: ${brand}; }
  .pop .plabel { font-size: 11.5px; letter-spacing: .1em; color: #5b6470; }
  .pop a { color: #1a1d21; font-size: 13.5px; font-weight: 500; border-bottom: 2px solid ${tint(brand, 0.6)}; }
  .pop a:hover { color: ${brand}; border-color: ${brand}; }
  .catnav { display: flex; gap: 6px 14px; flex-wrap: wrap; margin-top: 18px; border-bottom: 1px solid #d9dde3; padding-bottom: 10px; }
  .catnav a { font-size: 13.5px; color: #454c55; font-weight: 500; padding: 2px 0; border-bottom: 2px solid transparent; }
  .catnav a:hover { color: ${brand}; border-color: ${brand}; }
  .catnav a em { font-style: normal; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: #767f8b; }
  .cat > h2 { font-size: 11.5px; letter-spacing: .1em; text-transform: uppercase; color: #5b6470; font-weight: 500; }
  ul.articles { list-style: none; }
  .arti { display: flex; align-items: baseline; gap: 12px; padding: 10px 0; border-bottom: 1px solid #e4e7eb; color: inherit; }
  .arti > div { flex: 1; }
  .arti:hover h3 { color: ${brand}; }
  .arti h3 { color: #1a1d21; font-weight: 500; font-size: 15.5px; }
  .arti p { color: #5b6470; font-size: 13px; }
  .arti .dt { font-size: 11.5px; color: #767f8b; white-space: nowrap; }
  .no-results { color: #5b6470; }
  .meta { color: #5b6470; font-size: 12px; }
  .sum { background: ${tint(brand, 0.92)}; border-radius: 8px; padding: 10px 14px; font-size: 14px;
    color: #454c55; margin: 14px 0 16px; }
  .sum b { color: ${brand}; }
  .artwrap { margin-top: 14px; }
  .artbody p, .artbody li { color: #383f47; max-width: 66ch; font-size: 15px; }
  .artbody.raw { white-space: pre-wrap; font-size: 15px; }
  .step .n { border-radius: 6px; font-family: 'IBM Plex Mono', monospace; font-weight: 500; }
  .callout { border: 1px solid #d9dde3; border-left: 3px solid ${brand}; background: #fff; }
  .rel { border-top: 1px solid #e4e7eb; }
  .rel .rlabel { font-family: 'IBM Plex Mono', monospace; letter-spacing: .1em; color: #5b6470; font-weight: 500; }
  .hlp { color: #5b6470; }
  .hlp button { border: 1px solid #b8bfc9; color: #1a1d21; }
  .hlp button:hover { border-color: ${brand}; color: ${brand}; }
  .ask { border: 1px solid #d9dde3; border-radius: 10px; }
  .ask p { color: #454c55; }
  .btn { background: ${brand}; color: ${readableOn(brand)}; border-radius: 7px; }
  footer { border-top: 1px solid #d9dde3; }
  footer p { color: #5b6470; }
  footer b { color: #454c55; }
`

  // signwriter
  return base + `
  body { color: #24211f; background: #f4f5f4; }
  header { background: #fff; border-bottom: 1px solid #dde0dd; padding: 13px 0; }
  header .wrap { display: flex; align-items: center; gap: 16px; }
  header .home { color: #24211f; font-family: ${headFont}; font-weight: 600; font-size: 18px; }
  a { color: ${brand}; }
  .lead { color: #575450; }
  .search input { background: #fff; border: 1px solid #c9cdc9; border-radius: 8px; }
  .search input:focus { border-color: ${brand}; }
  .pop .plabel { font-family: ${headFont}; text-transform: none; letter-spacing: 0; font-size: 14.5px; color: ${brand}; }
  .pop a { background: #fff; border: 1px solid #c9cdc9; border-radius: 6px; padding: 5px 13px;
    font-size: 13px; font-weight: 600; color: #3c3936; }
  .pop a:hover { border-color: ${brand}; color: ${brand}; }
  .cat { background: #fff; border: 1px solid #dde0dd; border-radius: 10px; overflow: hidden; }
  .cat > h2 { background: ${brand}; color: ${onBrand}; font-size: 15.5px; font-weight: 600;
    padding: 8px 19px; margin: 0; display: flex; align-items: baseline; }
  .cat > h2 b { flex: 1; font-weight: 600; }
  .cat > h2 span { font-family: ${def.bodyFont}; font-size: 12px; opacity: .8; }
  ul.articles { list-style: none; }
  .arti { display: flex; align-items: center; gap: 13px; padding: 12px 19px; border-top: 1px solid #eceeec; color: inherit; }
  li:first-child .arti { border-top: none; }
  .arti .num { width: 25px; height: 25px; border-radius: 50%; background: ${brand}; color: ${onBrand};
    display: flex; align-items: center; justify-content: center; font-size: 12.5px; font-weight: 700; flex: none; }
  .arti > div { flex: 1; }
  .arti:hover h3 { color: ${brand}; }
  .arti h3 { color: #24211f; font-weight: 600; font-size: 15.5px; font-family: ${def.bodyFont}; }
  .arti p { color: #575450; font-size: 13px; }
  .no-results, .meta { color: #6c6965; }
  .artwrap { background: #fff; border-radius: 10px; padding: 30px 30px 24px; margin-top: 14px;
    border-top: 3px solid ${brand}; box-shadow: 0 5px 0 -4px ${brand}; }
  .artbody p, .artbody li { color: #423f3c; }
  .artbody .lede { font-family: ${headFont}; font-size: 17.5px; color: #24211f; }
  .artbody.raw { white-space: pre-wrap; font-size: 15.5px; }
  .rel { border-top: 1px solid #eceeec; }
  .rel .rlabel { font-family: ${headFont}; text-transform: none; letter-spacing: 0; font-size: 14.5px; color: ${brand}; }
  .rel a { color: #24211f; border-bottom: 1px solid #c9cdc9; font-weight: 400; }
  .hlp { color: #575450; }
  .hlp button { border: 1px solid #c9cdc9; border-radius: 6px; color: #24211f; }
  .hlp button:hover { border-color: ${brand}; color: ${brand}; }
  .ask { background: ${shade(brand, 0.62)}; border-radius: 12px; }
  .ask h2 { color: ${readableOn(shade(brand, 0.62))}; font-family: ${headFont}; font-size: 18px; }
  .ask p { color: ${readableOn(shade(brand, 0.62))}; opacity: .82; }
  .ask .btn { background: #fff; color: ${brand}; }
  .btn { background: ${brand}; color: ${onBrand}; border-radius: 6px; font-weight: 700; }
  footer { border-top: 1px solid #dde0dd; }
  footer p { color: #6c6965; }
  footer b { color: #575450; }
  @media (max-width: 560px) { .artwrap { padding: 22px 18px; } }
`
}

// ── Shared chrome ────────────────────────────────────────────────────────

const chrome = (o: {
  title: string
  description: string
  canonical: string
  brand: string
  siteName: string
  slug: string
  body: string
  theme: HelpTheme
  opts: HelpRenderOpts
  config?: AssistantConfigRow
  noindex?: boolean
  jsonLd?: string
}): string => {
  const def = THEME_FONTS[o.theme]
  const genieFont =
    o.opts.tier === 'genie' && o.config?.helpFontHead && GOOGLE_FONT_RE.test(o.config.helpFontHead)
      ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(o.config.helpFontHead).replace(/%20/g, '+')}:wght@500;600;700&display=swap`
      : undefined
  const fontLinks = [def.fontHref, genieFont]
    .filter(Boolean)
    .map((href) => `<link rel="stylesheet" href="${href}" />`)
    .join('\n')
  const logo = o.opts.logoUrl
    ? `<img class="logo" src="${esc(o.opts.logoUrl)}" alt="" />`
    : ''
  const badge =
    o.opts.tier === 'genie'
      ? `<p>© ${esc(o.siteName.replace(/ help centre$/i, ''))} ${new Date().getFullYear()}</p>`
      : `<p>Help centre powered by <a href="https://makerbay.app"><b>MakerBay</b></a></p>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}" />
${o.noindex ? '<meta name="robots" content="noindex" />' : ''}
<link rel="canonical" href="${esc(o.canonical)}" />
<meta property="og:title" content="${esc(o.title)}" />
<meta property="og:description" content="${esc(o.description)}" />
<meta property="og:url" content="${esc(o.canonical)}" />
<meta property="og:type" content="article" />
${fontLinks ? '<link rel="preconnect" href="https://fonts.googleapis.com" />\n' + fontLinks : ''}
${o.jsonLd ? `<script type="application/ld+json">${o.jsonLd}</script>` : ''}
<style>${styles(o.theme, o.brand, o.opts, o.config?.helpFontHead)}</style>
</head>
<body>
<header>
  <div class="wrap">
    <a class="home" href="/${esc(o.slug)}">${logo}<span>${esc(o.siteName)}</span></a>
    <a class="btn" href="https://chat.makerbay.app/${esc(o.slug)}">Ask a question</a>
  </div>
</header>
<main class="wrap">
${o.body}
</main>
<footer>
  <div class="wrap">${badge}</div>
</footer>
${
  // The assistant answers right here instead of bouncing the reader to a
  // separate chat page (issue 67). The links keep their hrefs so a crawler
  // or no-JavaScript reader still lands somewhere useful.
  o.slug
    ? `<script src="https://widget.makerbay.app/widget.js" data-slug="${esc(o.slug)}" data-color="${esc(o.brand)}" defer></script>
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
}

const askBlock = (slug: string, assistantName: string, opts: HelpRenderOpts): string => {
  const contact = [opts.phone, opts.email]
    .filter((c): c is string => Boolean(c))
    .map(esc)
    .join(' · ')
  return `
<div class="ask">
  <div>
    <h2>Still stuck?</h2>
    <p>Ask ${esc(assistantName)} - it answers from these same documents, instantly.${contact ? ` Or reach us: ${contact}.` : ''}</p>
  </div>
  <a class="btn" href="https://chat.makerbay.app/${esc(slug)}">Ask a question</a>
</div>`
}

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
      theme: 'clean',
      opts: { tier: 'free' },
      noindex: true,
      body: '<div class="hero"><h1>Nothing here</h1><p class="lead">This help centre does not exist, or has not been published yet.</p></div>',
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

const categoryOrder = (config: AssistantConfigRow): string[] => {
  const custom = (config.helpCategoryOrder ?? []).filter((c) => CATEGORY_ORDER.includes(c))
  return custom.length ? [...custom, ...CATEGORY_ORDER.filter((c) => !custom.includes(c))] : CATEGORY_ORDER
}

export function renderIndex(
  config: AssistantConfigRow,
  slug: string,
  sources: SourceRow[],
  excerpts: Record<string, string>,
  opts: HelpRenderOpts,
): APIGatewayProxyResultV2 {
  const theme = resolveTheme(config, opts.tier)
  const siteName = config.helpTitle?.trim() || `${config.name} help centre`
  const intro = config.helpIntro?.trim() || 'Straight answers about our services, prices and how we work.'

  const describe = (s: SourceRow): string =>
    s.helpMeta?.description ??
    `${(excerpts[s.sourceId] ?? '').slice(0, 150)}${(excerpts[s.sourceId] ?? '').length > 150 ? '…' : ''}`

  // Popular: the owner's pins, else the most recently updated articles. At
  // 10-40 articles a four-link strip resolves most visits before the
  // category grid is even scanned.
  const pinned = (config.helpPinned ?? [])
    .map((id) => sources.find((s) => s.sourceId === id))
    .filter((s): s is SourceRow => Boolean(s))
  const popular = (pinned.length
    ? pinned
    : [...sources].sort((a, b) => (b.fetchedAt ?? b.updatedAt).localeCompare(a.fetchedAt ?? a.updatedAt))
  ).slice(0, 4)
  const popStrip =
    sources.length > 4 && popular.length
      ? `<div class="pop"><span class="plabel">Popular</span>${popular
          .map((s) => `<a href="/${esc(slug)}/${esc(articleSlug(s))}">${esc(titleOf(s))}</a>`)
          .join('')}</div>`
      : ''

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
  const orderedCats = categoryOrder(config).filter((c) => groups.has(c))
  const showHeadings = orderedCats.length > 1

  const dateShort = (s: SourceRow): string =>
    new Date(s.fetchedAt ?? s.updatedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })

  const item = (s: SourceRow, i: number) => {
    const inner =
      theme === 'signwriter'
        ? `<span class="num">${i + 1}</span><div><h3>${esc(titleOf(s))}</h3><p>${esc(describe(s))}</p></div>`
        : theme === 'ledger'
          ? `<div><h3>${esc(titleOf(s))}</h3><p>${esc(describe(s))}</p></div><span class="dt">${esc(dateShort(s))}</span>`
          : `<h3>${esc(titleOf(s))}</h3><p>${esc(describe(s))}</p>`
    return `    <li data-t="${esc((titleOf(s) + ' ' + describe(s)).toLowerCase())}"><a class="arti" href="/${esc(slug)}/${esc(articleSlug(s))}">${inner}</a></li>`
  }

  const headingFor = (cat: string, count: number): string =>
    theme === 'signwriter'
      ? `<h2><b>${esc(cat)}</b><span>${count} article${count === 1 ? '' : 's'}</span></h2>`
      : `<h2>${esc(cat)} <span>· ${count}</span></h2>`

  const list = sources.length
    ? orderedCats
        .map((cat, ci) => {
          const items = groups.get(cat)!
          return `<section class="cat" data-cat id="cat-${ci}">
  ${showHeadings ? headingFor(cat, items.length) : ''}
  <ul class="articles">
${items.map(item).join('\n')}
  </ul>
</section>`
        })
        .join('\n')
    : '<p class="no-results">No articles have been published yet.</p>'

  // Ledger reads like a manual, so it gets the manual's contents line: a
  // category jump row with counts, right under the search.
  const catNav =
    theme === 'ledger' && showHeadings
      ? `<nav class="catnav">${orderedCats
          .map((c, ci) => `<a href="#cat-${ci}">${esc(c)} <em>${groups.get(c)!.length}</em></a>`)
          .join('')}</nav>`
      : ''

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

  const hero =
    theme === 'bold'
      ? `<div class="hero heroin"><div class="wrap-x"><h1>${esc(siteName)}</h1><p class="lead">${esc(intro)}</p></div></div>`
      : `<div class="hero"><h1>${esc(siteName)}</h1><p class="lead">${esc(intro)}</p></div>`

  // Bold's hero runs full-bleed: it renders outside .wrap, so the body is
  // assembled differently there (hero, then the wrapped content).
  const body =
    theme === 'bold'
      ? `</main>${hero.replace('wrap-x', 'wrap')}<main class="wrap">
${search}
${popStrip}
${catNav}
${list}
${askBlock(slug, config.name, opts)}`
      : `${hero}
${search}
${popStrip}
${catNav}
${list}
${askBlock(slug, config.name, opts)}`

  return html(
    200,
    chrome({
      title: siteName,
      description: intro,
      canonical: `${HELP_ORIGIN}/${slug}`,
      brand: config.brandColor,
      siteName,
      slug,
      theme,
      opts,
      config,
      // An empty help centre should not be indexed as a thin page.
      noindex: sources.length === 0,
      body,
    }),
    // The index is where a fresh publish shows up; cache it lightly so the
    // owner sees their change in about a minute, not five (issue 65).
    60,
  )
}

// ── Article body rendering ───────────────────────────────────────────────

const inline = (s: string): string => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

/**
 * Markdown-lite to HTML: the exact subset generateHelpBody is told to emit.
 * Everything is escaped first; the transforms below only ever add tags.
 */
export function renderHelpBody(md: string): string {
  const lines = md.replace(/\r/g, '').split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: string[] = []
  let first = true

  const flushPara = () => {
    if (!para.length) return
    const text = para.join(' ').trim()
    para = []
    if (!text) return
    const callout = text.match(/^(Tip|Note|Warning):\s*(.*)$/s)
    if (callout) {
      const warn = callout[1] === 'Warning' ? ' warn' : ''
      out.push(`<div class="callout${warn}"><b>${callout[1]}</b> — ${inline(callout[2])}</div>`)
      return
    }
    out.push(`<p${first ? ' class="lede"' : ''}>${inline(text)}</p>`)
    first = false
  }
  const flushList = () => {
    if (!list.length) return
    out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`)
    list = []
  }

  for (const line of lines) {
    const t = line.trim()
    if (!t) { flushList(); flushPara(); continue }
    const h = t.match(/^#{2,3}\s+(.*)$/)
    if (h) {
      flushList(); flushPara(); first = false
      const step = h[1].match(/^(\d+)[.)]\s+(.*)$/)
      if (step) out.push(`<div class="step"><span class="n">${step[1]}</span><h2>${inline(step[2])}</h2></div>`)
      else out.push(`<h2 class="h2p">${inline(h[1])}</h2>`)
      continue
    }
    if (/^[-*]\s+/.test(t)) { flushPara(); list.push(t.replace(/^[-*]\s+/, '')); continue }
    flushList()
    para.push(t)
  }
  flushList(); flushPara()
  return out.join('\n')
}

const readMinutes = (text: string): number => Math.max(1, Math.round(text.split(/\s+/).length / 200))

export function renderArticle(
  config: AssistantConfigRow,
  slug: string,
  source: SourceRow,
  text: string,
  opts: HelpRenderOpts,
  formattedBody?: string,
  related: SourceRow[] = [],
): APIGatewayProxyResultV2 {
  const theme = resolveTheme(config, opts.tier)
  const siteName = config.helpTitle?.trim() || `${config.name} help centre`
  const title = titleOf(source)
  const updated = source.fetchedAt ?? source.updatedAt
  const description = (source.helpMeta?.description || text.replace(/\s+/g, ' ').slice(0, 300))
  const category = source.helpMeta?.category ?? 'General'
  const updatedNice = new Date(updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  const bodyHtml = formattedBody
    ? `<div class="artbody">${renderHelpBody(formattedBody)}</div>`
    : `<div class="artbody raw">${esc(text)}</div>`

  const relBlock = related.length
    ? `<div class="rel"><span class="rlabel">Related</span>${related
        .map((r) => `<a href="/${esc(slug)}/${esc(articleSlug(r))}">${esc(titleOf(r))}</a>`)
        .join('')}</div>`
    : ''

  // "Was this helpful" posts to the open public API (CORS *), then thanks the
  // reader in place. The buttons are real buttons, not links, so crawlers
  // never vote.
  const helpBlock = `<div class="hlp" id="hlp">Was this helpful?
<button type="button" data-h="1">Yes</button><button type="button" data-h="0">No</button></div>
<script>
document.querySelectorAll('#hlp button').forEach(function (b) {
  b.addEventListener('click', function () {
    fetch('${API_ORIGIN}/v1/public/assistant/helpful', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: '${esc(slug)}', sourceId: '${esc(source.sourceId)}', helpful: b.getAttribute('data-h') === '1' })
    }).catch(function () {})
    document.getElementById('hlp').textContent = 'Thanks for the feedback.'
  })
})
</script>`

  const jsonLd = JSON.stringify([
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: title,
      description,
      dateModified: updated,
      mainEntityOfPage: `${HELP_ORIGIN}/${slug}/${articleSlug(source)}`,
      publisher: { '@type': 'Organization', name: siteName },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: siteName, item: `${HELP_ORIGIN}/${slug}` },
        { '@type': 'ListItem', position: 2, name: category },
        { '@type': 'ListItem', position: 3, name: title },
      ],
    },
  ])

  return html(
    200,
    chrome({
      title: `${title} - ${siteName}`,
      description: description.slice(0, 300),
      canonical: `${HELP_ORIGIN}/${slug}/${articleSlug(source)}`,
      brand: config.brandColor,
      siteName,
      slug,
      theme,
      opts,
      config,
      jsonLd,
      body: `<a class="crumb" href="/${esc(slug)}">&larr; All articles</a> <span class="crumb" style="opacity:.6">→ ${esc(category)}</span>
<div class="artwrap">
<h1>${esc(title)}</h1>
<p class="meta">Updated <time datetime="${esc(updated)}">${esc(updatedNice)}</time> · ${readMinutes(formattedBody ?? text)} min read</p>
${bodyHtml}
${relBlock}
${helpBlock}
</div>
${askBlock(slug, config.name, opts)}`,
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
