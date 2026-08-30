/**
 * The business page renderer. Pure: no AWS, no clock, no I/O - everything it
 * needs arrives as arguments, so the indexing rules can be unit tested.
 *
 * Server-rendered HTML for the same reason as the help centre: the page exists
 * to be found, and a page that needs JavaScript to show its content indexes
 * badly. Every word on it was entered by the owner or computed from their real
 * configuration. Nothing is generated - a templated-prose corpus across tenants
 * is the scaled-content-abuse profile, and it would take every tenant's page
 * down together. See docs/analysis-search-visibility.md.
 */

import { readableOn } from '@makerbay/core/color'
import { money } from '@makerbay/core/money'
import { DEFAULT_BLOCKS, type AssistantView, type BlockId, type FontPair, type HoursView, type PresenceConfigRow, type ServiceView } from './db'

export interface ReviewView {
  rating: number
  text?: string
  name?: string
}

export interface PageInput {
  config: PresenceConfigRow
  businessName: string
  slug: string
  services: ServiceView[]
  hours?: HoursView
  assistant: AssistantView
  hasKnowledge: boolean
  bookingEnabled: boolean
  /** Published first-party reviews, when the Reviews module is on. */
  reviews?: { average: number; count: number; items: ReviewView[] }
  /** Workspace currency (from Quotes settings). Service prices render in it. */
  currency?: string
  /**
   * Where this page canonically lives. Defaults to makerbay.app/p/{slug};
   * an active custom domain takes over as the canonical home, and the free
   * page points at it - same content, one address in the index.
   */
  canonicalUrl?: string
  /** The instant of rendering, passed in so open/closed is testable. */
  now: Date
  /** Rendering a sub-page (grow/storefront styles) instead of the home page. */
  sub?: SubPage
  /** Pre-generated scan-to-book QR (issue 60), when the owner enables it. */
  qr?: { dataUri: string; label: string }
}

export type SubPage = 'services' | 'faq' | 'reviews'
export const SUB_PAGES: SubPage[] = ['services', 'faq', 'reviews']

/**
 * Curated font pairings (Genie), loaded only when chosen.
 *
 * Served from our own bucket, not Google's. These pages are read by
 * homeowners with no relationship to MakerBay, and while the faces came from
 * fonts.googleapis.com every one of those visits handed the reader's IP
 * address to a third party (issue 133). Regenerate with
 * scripts/vendor-fonts.mjs; publish with scripts/publish-embed.mjs.
 */
const FONT_PAIR_DEFS: Record<Exclude<FontPair, 'system'>, { head: string; body: string; href: string }> = {
  classic: {
    head: "'Playfair Display', Georgia, serif",
    body: "'Lora', Georgia, serif",
    href: 'https://chat.makerbay.app/fonts/playfairdisplay.css',
  },
  modern: {
    head: "'Inter', 'Segoe UI', sans-serif",
    body: "'Inter', 'Segoe UI', sans-serif",
    href: 'https://chat.makerbay.app/fonts/inter.css',
  },
  editorial: {
    head: "'Fraunces', Georgia, serif",
    body: "'Source Sans 3', 'Segoe UI', sans-serif",
    href: 'https://chat.makerbay.app/fonts/fraunces.css',
  },
  friendly: {
    head: "'Nunito', 'Segoe UI', sans-serif",
    body: "'Nunito Sans', 'Segoe UI', sans-serif",
    href: 'https://chat.makerbay.app/fonts/nunito.css',
  },
}

export const PAGE_ORIGIN = 'https://makerbay.app'
export const CHAT_ORIGIN = 'https://chat.makerbay.app'
export const PHOTO_ORIGIN = 'https://chat.makerbay.app'

const esc = (s: string): string =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

// ── Indexing rules (docs/spec-presence.md §7) ────────────────────────────

/**
 * A page is indexable only when it is genuinely complete: a real intro, at
 * least one priced service, and a photo. This keeps our index at roughly one
 * page per real business rather than one per signup - the difference between
 * a corpus Google trusts and one it discounts wholesale.
 */
export function isComplete(input: Pick<PageInput, 'config' | 'services'>): boolean {
  const { config, services } = input
  return (
    config.intro.trim().length >= 40 &&
    Boolean(config.photoKey) &&
    services.some((s) => s.priceCents != null && s.priceCents > 0)
  )
}

export type IndexDirective = 'index' | 'noindex'

export function indexDirective(input: Pick<PageInput, 'config' | 'services'>): IndexDirective {
  // The tradie's own site wins their brand query; we do not compete with our
  // own customer. noindex,follow rather than a cross-domain canonical.
  if (input.config.websiteUrl?.trim()) return 'noindex'
  return isComplete(input) ? 'index' : 'noindex'
}

// ── Open/closed, computed in the business timezone ───────────────────────

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const DAY_LABEL: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
}

function zonedParts(now: Date, timezone: string): { day: string; hhmm: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]))
  return {
    day: String(parts.weekday ?? 'Mon').slice(0, 3).toLowerCase(),
    // Intl renders midnight as 24 in some environments.
    hhmm: `${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}`,
  }
}

export interface OpenState {
  open: boolean
  label: string
}

export function openState(hours: HoursView, now: Date): OpenState {
  const { day, hhmm } = zonedParts(now, hours.timezone)
  const windows = hours.hours[day] ?? []
  const within = windows.find((w) => hhmm >= w.from && hhmm < w.to)
  if (within) return { open: true, label: `Open now, until ${within.to}` }

  const later = windows.find((w) => hhmm < w.from)
  if (later) return { open: false, label: `Closed now, opens at ${later.from}` }

  // Walk forward to the next day with any opening window.
  const start = WEEKDAYS.indexOf(day as (typeof WEEKDAYS)[number])
  for (let i = 1; i <= 7; i++) {
    const next = WEEKDAYS[(start + i) % 7]
    const w = hours.hours[next]?.[0]
    if (w) {
      const dayName = i === 1 ? 'tomorrow' : DAY_LABEL[next]
      return { open: false, label: `Closed now, back ${dayName} at ${w.from}` }
    }
  }
  return { open: false, label: 'Closed' }
}

// ── JSON-LD, built only from entered data ────────────────────────────────

export function localBusinessJsonLd(input: PageInput): string {
  const { config, businessName, slug, services, hours } = input
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: businessName,
    url: input.canonicalUrl ?? `${PAGE_ORIGIN}/p/${slug}`,
  }
  if (config.phone) data.telephone = config.phone
  if (config.email) data.email = config.email
  if (config.intro.trim()) data.description = config.intro.trim().slice(0, 300)
  if (config.serviceAreas.length) data.areaServed = config.serviceAreas
  if (config.photoKey) data.image = `${PHOTO_ORIGIN}/${config.photoKey}`

  const offers = services
    .filter((s) => s.priceCents != null && s.priceCents > 0)
    .map((s) => ({
      '@type': 'Offer',
      itemOffered: { '@type': 'Service', name: s.name },
      price: (s.priceCents! / 100).toFixed(2),
      priceCurrency: input.currency ?? 'AUD',
    }))
  if (offers.length) data.makesOffer = offers

  if (hours) {
    const spec = Object.entries(hours.hours)
      .filter(([, w]) => w && w.length)
      .map(([day, w]) => ({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: DAY_LABEL[day],
        opens: w![0].from,
        closes: w![w!.length - 1].to,
      }))
    if (spec.length) data.openingHoursSpecification = spec
  }
  // JSON-LD lives in a <script> block; escape the one sequence that could
  // break out of it. Field values are already plain strings.
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

// ── The page ─────────────────────────────────────────────────────────────

export type ThemeStyle = 'fresh' | 'warm' | 'bold'
export const THEME_STYLES: ThemeStyle[] = ['fresh', 'warm', 'bold']

/**
 * Three named looks, all built from the same tokens so every block works in
 * every theme. fresh: clean and light. warm: cream paper and serif headings.
 * bold: dark hero band, heavy type.
 */
const THEME_VARS: Record<ThemeStyle, string> = {
  fresh: `--paper: #ffffff; --panel: #faf9f7; --ink: #1c1917; --body: #57534e; --muted: #a8a29e;
    --line: #e7e5e4; --hero-bg: transparent; --hero-ink: var(--ink); --hero-sub: var(--body);
    --head-font: inherit; --radius: 14px;`,
  warm: `--paper: #faf6ef; --panel: #f3ecdf; --ink: #292018; --body: #5c5044; --muted: #a3937f;
    --line: #e6dccb; --hero-bg: transparent; --hero-ink: var(--ink); --hero-sub: var(--body);
    --head-font: Georgia, 'Times New Roman', serif; --radius: 10px;`,
  bold: `--paper: #ffffff; --panel: #f5f5f4; --ink: #18181b; --body: #52525b; --muted: #a1a1aa;
    --line: #e4e4e7; --hero-bg: #18181b; --hero-ink: #fafafa; --hero-sub: #d4d4d8;
    --head-font: inherit; --radius: 16px;`,
}

const styles = (brand: string, theme: ThemeStyle, config: PresenceConfigRow) => {
  // Palette overrides (Trade) sit after the theme tokens so they win.
  const p = config.palette ?? {}
  const overrides = [
    p.paper ? `--paper: ${esc(p.paper)}; --panel: ${esc(p.paper)};` : '',
    p.ink ? `--ink: ${esc(p.ink)}; --body: ${esc(p.ink)}cc; --hero-ink: ${esc(p.ink)};` : '',
    p.button ? `--brand: ${esc(p.button)};` : '',
  ].join(' ')
  const buttonColor = p.button ?? brand
  const fp = config.fontPair && config.fontPair !== 'system' ? FONT_PAIR_DEFS[config.fontPair] : undefined
  const fonts = fp ? `--head-font: ${fp.head}; --body-font: ${fp.body};` : ''
  return `
  :root { --brand: ${esc(brand)}; --brand-fg: ${readableOn(buttonColor)}; --ok: #15803d; --ok-sub: #dcfce7; ${THEME_VARS[theme]} ${overrides} ${fonts} }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--body-font, 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', sans-serif);
    color: var(--ink); background: var(--paper); line-height: 1.65; font-size: 17px;
    -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 22px; }
  h1, h2 { font-family: var(--head-font); }

  .hero { background: var(--hero-bg); padding: ${theme === 'bold' ? '40px 0 44px' : '44px 0 34px'}; }
  .hero-inner { }
  .hero img.photo { width: 100%; max-height: 340px; object-fit: cover; border-radius: var(--radius);
    margin-bottom: 26px; box-shadow: 0 10px 34px rgba(0,0,0,.12); }
  h1 { font-size: clamp(30px, 5.4vw, 44px); line-height: 1.12; letter-spacing: -0.02em; color: var(--hero-ink); }
  .headline { color: var(--hero-sub); font-size: 19.5px; margin-top: 8px; max-width: 54ch; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; align-items: center; }
  .chip { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 13.5px; font-weight: 600; }
  .chip.area { background: ${theme === 'bold' ? 'rgba(255,255,255,.12)' : 'var(--panel)'};
    color: ${theme === 'bold' ? '#e4e4e7' : 'var(--body)'}; border: 1px solid ${theme === 'bold' ? 'transparent' : 'var(--line)'}; }
  .chip.open { background: var(--ok-sub); color: var(--ok); }
  .chip.closed { background: ${theme === 'bold' ? 'rgba(255,255,255,.12)' : 'var(--panel)'};
    color: ${theme === 'bold' ? '#e4e4e7' : 'var(--body)'}; border: 1px solid ${theme === 'bold' ? 'transparent' : 'var(--line)'}; }
  .cta { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 24px; }
  .btn { display: inline-block; background: var(--brand); color: var(--brand-fg, #fff); text-decoration: none;
    padding: 13px 26px; border-radius: 10px; font-weight: 650; font-size: 16px;
    box-shadow: 0 4px 14px rgba(0,0,0,.12); }
  .btn.ghost { background: ${theme === 'bold' ? 'rgba(255,255,255,.08)' : 'transparent'};
    color: ${theme === 'bold' ? '#fafafa' : 'var(--brand)'};
    box-shadow: inset 0 0 0 1.5px ${theme === 'bold' ? 'rgba(255,255,255,.35)' : 'var(--brand)'}; }

  section { padding: 34px 0; }
  section + section { border-top: 1px solid var(--line); }
  h2 { font-size: 21px; letter-spacing: -0.01em; margin-bottom: 16px; }
  .intro { color: var(--body); white-space: pre-wrap; max-width: 62ch; }

  ul.services { list-style: none; display: grid; gap: 10px; }
  ul.services li { display: flex; gap: 14px; align-items: baseline; padding: 15px 18px;
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
  .svc-name { font-weight: 650; }
  .svc-desc { color: var(--muted); font-size: 14.5px; }
  .svc-meta { margin-left: auto; text-align: right; white-space: nowrap; font-size: 15.5px; }
  .svc-price { font-weight: 700; color: var(--ink); }
  .svc-mins { color: var(--muted); font-size: 13.5px; display: block; }

  .rev-sum { color: var(--body); margin-bottom: 16px; font-size: 16px; }
  .rev-stars { color: #f59e0b; letter-spacing: 1.5px; }
  .rev-grid { display: grid; gap: 12px; }
  blockquote.rev { margin: 0; padding: 16px 18px; background: var(--panel);
    border: 1px solid var(--line); border-radius: var(--radius); }
  blockquote.rev p { color: var(--body); margin-top: 6px; }
  blockquote.rev cite { color: var(--muted); font-style: normal; font-size: 14px; display: block; margin-top: 8px; }

  .hours-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 4px 28px; max-width: 560px; }
  .hours-row { display: flex; justify-content: space-between; padding: 6px 0;
    border-bottom: 1px dashed var(--line); font-size: 15.5px; color: var(--body); }
  .hours-row .d { font-weight: 600; color: var(--ink); }
  .hours-row.today { color: var(--ink); }
  .hours-row.today .d::after { content: ' · today'; color: var(--brand); font-size: 12.5px; }

  .contact a { color: var(--brand); text-decoration: none; font-weight: 600; }
  .contact-row { display: flex; align-items: center; gap: 26px; flex-wrap: wrap; justify-content: space-between; }
  .qr-side { display: flex; align-items: center; gap: 12px; }
  .qr-side img { border: 1px solid var(--line); border-radius: 10px; background: #fff; padding: 4px; }
  .qr-side span { color: var(--muted); font-size: 13.5px; max-width: 14ch; }
  footer { border-top: 1px solid var(--line); margin-top: 20px; padding: 26px 0 96px; }
  footer p { color: var(--muted); font-size: 13.5px; }
  footer a { color: var(--muted); }

  /* In-page chat and booking: a floating layer over the page, so nobody is
     sent away to a different site mid-thought. */
  .mb-fab { position: fixed; right: 18px; bottom: 18px; z-index: 40; border: none; cursor: pointer;
    background: var(--brand); color: var(--brand-fg, #fff); border-radius: 28px; padding: 14px 22px;
    font: inherit; font-weight: 650; font-size: 15.5px; box-shadow: 0 8px 26px rgba(0,0,0,.25); }
  .mb-overlay { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.45); display: none; }
  .mb-overlay.on { display: block; }
  .mb-panel { position: absolute; right: 16px; bottom: 16px; width: min(420px, calc(100vw - 32px));
    height: min(640px, calc(100vh - 32px)); background: #fff; border-radius: 16px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(0,0,0,.35); display: flex; flex-direction: column; }
  .mb-panel iframe { border: 0; flex: 1; width: 100%; }
  .mb-close { position: absolute; top: 8px; right: 12px; z-index: 2; border: none; cursor: pointer;
    background: rgba(0,0,0,.55); color: #fff; border-radius: 50%; width: 32px; height: 32px;
    font-size: 16px; line-height: 32px; }
  @media (max-width: 560px) {
    .mb-panel { right: 0; bottom: 0; width: 100vw; height: 92vh; border-radius: 16px 16px 0 0; }
  }

  /* Storefront nav and grow-style "see all" links */
  nav.pages { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 22px; }
  nav.pages a { padding: 8px 16px; border-radius: 9px; text-decoration: none; font-weight: 650;
    font-size: 15px; color: var(--hero-ink); opacity: .75; }
  nav.pages a.on { background: var(--brand); color: var(--brand-fg, #fff); opacity: 1; }
  h2 .seeall { float: right; font-size: 14.5px; font-weight: 650; color: var(--brand); text-decoration: none; }
  .crumb { color: var(--muted); font-size: 14px; margin: 24px 0 0; }
  .crumb a { color: var(--brand); text-decoration: none; font-weight: 600; }

  /* FAQ accordion: native details, works with scripts off */
  .faq details { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel);
    padding: 0; margin-bottom: 10px; }
  .faq summary { cursor: pointer; font-weight: 650; padding: 14px 18px; list-style: none; }
  .faq summary::-webkit-details-marker { display: none; }
  .faq summary::after { content: '+'; float: right; color: var(--brand); font-weight: 700; }
  .faq details[open] summary::after { content: '\\2212'; }
  .faq .a { padding: 0 18px 14px; color: var(--body); white-space: pre-wrap; }

  /* Small screens: generous tap targets, single column, no horizontal scroll. */
  @media (max-width: 560px) {
    body { font-size: 16px; }
    .hero { padding-top: 26px; }
    .cta .btn { flex: 1 1 auto; text-align: center; }
    ul.services li { flex-wrap: wrap; }
    .svc-meta { margin-left: 0; text-align: left; }
  }
`
}

// The one currency->locale table, from core (issue 114). Whole dollars on the
// page customers actually read: "$80" is a headline here, not a figure.
const cash = (cents: number, currency = 'AUD') => money(cents, currency, { trimEvenCents: true })

export function renderPage(input: PageInput): string {
  const { config, businessName, slug, services, hours, assistant, hasKnowledge, bookingEnabled, sub } = input
  const directive = indexDirective(input)
  const style = config.pageStyle ?? 'simple'
  const state = hours ? openState(hours, input.now) : undefined
  const theme: ThemeStyle = THEME_STYLES.includes(config.themeStyle as ThemeStyle)
    ? (config.themeStyle as ThemeStyle)
    : 'fresh'
  const brand = /^#[0-9a-fA-F]{6}$/.test(config.accentColor ?? '')
    ? config.accentColor!
    : assistant.brandColor

  // Where sub-pages live: bare paths on a custom domain, /p/{slug}/… on ours.
  const onCustomDomain = Boolean(input.canonicalUrl && !input.canonicalUrl.includes('/p/'))
  const basePath = onCustomDomain ? '' : `/p/${slug}`
  const homeHref = basePath || '/'
  const subHref = (s: SubPage) => `${basePath}/${s}`
  const canonicalBase = (input.canonicalUrl ?? `${PAGE_ORIGIN}/p/${slug}`).replace(/\/$/, '')
  const canonical = sub ? `${canonicalBase}/${sub}` : input.canonicalUrl ?? `${PAGE_ORIGIN}/p/${slug}`
  const faq = config.faq ?? []
  const blockOrder = (config.blocks?.length ? config.blocks : DEFAULT_BLOCKS)
    .filter((b) => b.visible)
    .map((b) => b.id)

  const SUB_TITLES: Record<SubPage, string> = { services: 'Services & prices', faq: 'FAQ', reviews: 'Reviews' }
  const title = sub ? `${SUB_TITLES[sub]} — ${businessName}` : businessName
  const description = (config.intro.trim() || config.headline || businessName).slice(0, 155)

  // The page never shows a control that does nothing (spec §3). Each block
  // renders only when the module behind it can actually respond.
  const bookHref = `${CHAT_ORIGIN}/booking?slug=${encodeURIComponent(slug)}`
  const askHref = `${CHAT_ORIGIN}/${encodeURIComponent(slug)}`
  const showBooking = bookingEnabled && config.showBooking && services.length > 0
  const showAssistant = hasKnowledge && config.showAssistant

  // Plain links first: they work with JavaScript off. The script below
  // upgrades them into in-page overlays, so nobody is sent away mid-thought.
  const cta = [
    showBooking ? `<a class="btn" data-overlay="book" href="${bookHref}">Book a time</a>` : '',
    !showBooking && config.phone
      ? `<a class="btn" href="tel:${esc(config.phone)}">Call ${esc(config.phone)}</a>`
      : '',
    showAssistant ? `<a class="btn ghost" data-overlay="ask" href="${askHref}">Ask a question</a>` : '',
  ].filter(Boolean).join('\n      ')

  // Preview sizes for the grow style: enough to sell, small enough that the
  // sub-page earns its click.
  const PREVIEW = { services: 3, faq: 2, reviews: 2 }

  const seeAll = (s: SubPage, total: number) =>
    `<a class="seeall" href="${subHref(s)}">See all ${total} →</a>`

  const servicesBlockFor = (mode: 'full' | 'preview') => {
    if (!services.length) return ''
    const shown = mode === 'preview' && services.length > PREVIEW.services
      ? services.slice(0, PREVIEW.services)
      : services
    const link = shown.length < services.length ? seeAll('services', services.length) : ''
    return `<section id="services">
    <h2>Services${link}</h2>
    <ul class="services">
${shown
  .map(
    (s) => `      <li>
        <span><span class="svc-name">${esc(s.name)}</span>${s.description ? `<br /><span class="svc-desc">${esc(s.description)}</span>` : ''}</span>
        <span class="svc-meta">${s.priceCents != null && s.priceCents > 0 ? `<span class="svc-price">${cash(s.priceCents, input.currency)}</span>` : ''}<span class="svc-mins">${s.durationMinutes} min</span></span>
      </li>`,
  )
  .join('\n')}
    </ul>
  </section>`
  }

  const faqBlockFor = (mode: 'full' | 'preview') => {
    if (!faq.length) return ''
    const shown = mode === 'preview' && faq.length > PREVIEW.faq ? faq.slice(0, PREVIEW.faq) : faq
    const link = shown.length < faq.length ? seeAll('faq', faq.length) : ''
    return `<section id="faq" class="faq">
    <h2>Frequently asked questions${link}</h2>
${shown
  .map(
    (f, i) => `    <details${i === 0 ? ' open' : ''}>
      <summary>${esc(f.q)}</summary>
      <div class="a">${esc(f.a)}</div>
    </details>`,
  )
  .join('\n')}
  </section>`
  }

  // FAQPage structured data, only on indexable pages with real items.
  const faqJsonLd = faq.length && directive === 'index'
    ? `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      }).replace(/</g, '\\u003c')}</script>`
    : ''

  const today = hours ? zonedParts(input.now, hours.timezone).day : ''
  const hoursBlock = hours && Object.values(hours.hours).some((w) => w?.length)
    ? `<section id="hours">
    <h2>Hours</h2>
    <div class="hours-grid">
${(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const)
  .map((d) => {
    const w = hours.hours[d]
    return `      <div class="hours-row${d === today ? ' today' : ''}"><span class="d">${DAY_LABEL[d]}</span><span>${w?.length ? w.map((x) => `${x.from}–${x.to}`).join(', ') : 'Closed'}</span></div>`
  })
  .join('\n')}
    </div>
  </section>`
    : ''

  // Visible words only, no review structured data: Google treats review
  // markup about your own business on your own page as self-serving and
  // ignores it at best. The words still persuade the humans who land here.
  const reviewsBlockFor = (mode: 'full' | 'preview') => {
    if (!input.reviews || input.reviews.count === 0) return ''
    const cap = mode === 'preview' ? PREVIEW.reviews : 12
    const shown = input.reviews.items.slice(0, cap)
    const link = mode === 'preview' && input.reviews.items.length > PREVIEW.reviews
      ? seeAll('reviews', input.reviews.count)
      : ''
    return `<section id="reviews">
    <h2>What customers say${link}</h2>
    <p class="rev-sum"><span class="rev-stars">${'★'.repeat(Math.round(input.reviews.average))}</span> ${input.reviews.average.toFixed(1)} from ${input.reviews.count} review${input.reviews.count === 1 ? '' : 's'}</p>
    <div class="rev-grid">
${shown
  .map(
    (r) => `    <blockquote class="rev">
      <span class="rev-stars">${'★'.repeat(r.rating)}</span>
      ${r.text ? `<p>${esc(r.text)}</p>` : ''}
      ${r.name ? `<cite>${esc(r.name)}</cite>` : ''}
    </blockquote>`,
  )
  .join('\n')}
    </div>
  </section>`
  }

  const contactBits = [
    config.phone ? `<a href="tel:${esc(config.phone)}">${esc(config.phone)}</a>` : '',
    config.email ? `<a href="mailto:${esc(config.email)}">${esc(config.email)}</a>` : '',
    config.websiteUrl?.trim() ? `<a href="${esc(config.websiteUrl.trim())}" rel="noopener">${esc(config.websiteUrl.trim().replace(/^https?:\/\//, ''))}</a>` : '',
  ].filter(Boolean)

  // The overlay layer: one panel reused for chat and booking. Vanilla and
  // tiny; the links keep working as links when scripts are blocked.
  const overlayScript = showBooking || showAssistant
    ? `<div class="mb-overlay" id="mb-overlay" role="dialog" aria-modal="true">
  <div class="mb-panel">
    <button class="mb-close" id="mb-close" aria-label="Close">&times;</button>
    <iframe id="mb-frame" title="${esc(businessName)}" src="about:blank"></iframe>
  </div>
</div>
${showAssistant ? `<button class="mb-fab" id="mb-fab">Ask a question</button>` : ''}
<script>
(function () {
  var overlay = document.getElementById('mb-overlay')
  var frame = document.getElementById('mb-frame')
  function open(src) { frame.src = src; overlay.classList.add('on'); document.body.style.overflow = 'hidden' }
  function close() { overlay.classList.remove('on'); frame.src = 'about:blank'; document.body.style.overflow = '' }
  document.getElementById('mb-close').addEventListener('click', close)
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close() })
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close() })
  var fab = document.getElementById('mb-fab')
  if (fab) fab.addEventListener('click', function () { open(${JSON.stringify(askHref)}) })
  document.querySelectorAll('[data-overlay]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault()
      open(a.getAttribute('data-overlay') === 'book' ? ${JSON.stringify(bookHref)} : ${JSON.stringify(askHref)})
    })
  })
})()
</script>`
    : ''

  const aboutBlock = config.intro.trim()
    ? `<section id="about"><h2>About</h2><p class="intro">${esc(config.intro.trim())}</p></section>`
    : ''
  const qrBlock = input.qr
    ? `<div class="qr-side"><img src="${input.qr.dataUri}" alt="QR code" width="120" height="120" /><span>${esc(input.qr.label)}</span></div>`
    : ''
  const contactBlock = contactBits.length || qrBlock
    ? `<section class="contact" id="contact"><h2>Contact</h2><div class="contact-row"><p>${contactBits.join(' · ')}</p>${qrBlock}</div></section>`
    : ''

  // Which sub-pages exist for this page (content present + block visible +
  // a style that has sub-pages at all).
  const subAvailable = (s: SubPage): boolean => {
    if (style === 'simple') return false
    if (!blockOrder.includes(s as BlockId)) return false
    if (s === 'services') return services.length > 0
    if (s === 'faq') return faq.length > 0
    return Boolean(input.reviews && input.reviews.count > 0)
  }
  const navPages = SUB_PAGES.filter(subAvailable)
  const navBlock = style === 'storefront' && navPages.length
    ? `<nav class="pages">
      <a href="${homeHref}"${!sub ? ' class="on"' : ''}>Home</a>
      ${navPages.map((s) => `<a href="${subHref(s)}"${sub === s ? ' class="on"' : ''}>${SUB_TITLES[s]}</a>`).join('\n      ')}
    </nav>`
    : ''

  // How each block renders on the HOME page for the chosen style. In
  // storefront, the big blocks live on their pages and the home page stays
  // a landing; grow previews them in place.
  const homeMode: Record<BlockId, string> = {
    about: aboutBlock,
    services:
      style === 'storefront' && subAvailable('services')
        ? servicesBlockFor('preview')
        : servicesBlockFor(style === 'grow' ? 'preview' : 'full'),
    faq:
      style === 'storefront' && subAvailable('faq')
        ? ''
        : faqBlockFor(style === 'grow' ? 'preview' : 'full'),
    reviews:
      style === 'storefront' && subAvailable('reviews')
        ? ''
        : reviewsBlockFor(style === 'grow' ? 'preview' : 'full'),
    hours: hoursBlock,
    contact: contactBlock,
  }

  const heroFull = `<div class="hero">
  <div class="wrap hero-inner">
    ${config.photoKey && !sub ? `<img class="photo" src="${PHOTO_ORIGIN}/${esc(config.photoKey)}" alt="${esc(businessName)}" />` : ''}
    <h1>${sub ? esc(SUB_TITLES[sub]) : esc(businessName)}</h1>
    ${!sub && config.headline ? `<p class="headline">${esc(config.headline)}</p>` : ''}
    ${sub ? `<p class="headline">${esc(businessName)}</p>` : ''}
    ${!sub ? `<div class="chips">
      ${state ? `<span class="chip ${state.open ? 'open' : 'closed'}">${esc(state.label)}</span>` : ''}
      ${config.serviceAreas.slice(0, 6).map((a) => `<span class="chip area">${esc(a)}</span>`).join('\n      ')}
    </div>
    <div class="cta">
      ${cta}
    </div>` : ''}
    ${navBlock}
  </div>
</div>`

  const body = sub
    ? `${heroFull}
<div class="wrap">
  ${style !== 'storefront' ? `<p class="crumb"><a href="${homeHref}">← ${esc(businessName)}</a></p>` : ''}
  ${sub === 'services' ? servicesBlockFor('full') : sub === 'faq' ? faqBlockFor('full') : reviewsBlockFor('full')}
</div>`
    : `${heroFull}
<div class="wrap">
  ${blockOrder.map((id) => homeMode[id]).filter(Boolean).join('\n  ')}
</div>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
${directive === 'noindex' ? '<meta name="robots" content="noindex, follow" />' : ''}
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:type" content="website" />
${config.photoKey ? `<meta property="og:image" content="${PHOTO_ORIGIN}/${esc(config.photoKey)}" />` : ''}
${config.fontPair && config.fontPair !== 'system' ? `<link rel="preconnect" href="https://chat.makerbay.app" crossorigin /><link rel="stylesheet" href="${FONT_PAIR_DEFS[config.fontPair].href}" />` : ''}
<script type="application/ld+json">${localBusinessJsonLd(input)}</script>
${(!sub || sub === 'faq') && blockOrder.includes('faq') ? faqJsonLd : ''}
<style>${styles(brand, theme, config)}</style>
</head>
<body>
${body}
<footer>
  <div class="wrap"><p>Page by <a href="${PAGE_ORIGIN}">MakerBay</a>${
    // On the demo page only, the byline becomes an invitation (issue 145).
    //
    // Every tenant page already carries this line, and it is the cheapest
    // traffic this product will ever get. But a real tradesperson's page is
    // THEIR page: turning their footer into an advert for us would be taking
    // something that is not ours, on a page their customer is reading. The
    // demo workspace is ours, so the ask goes there and nowhere else.
    slug === 'makerbay-demo'
      ? ` &middot; <a href="${PAGE_ORIGIN}/#top">Want one like this? Build yours in a minute</a>`
      : ''
  }</p></div>
</footer>
${overlayScript}
</body>
</html>
`
}

/** 404 for unknown or unpublished slugs: indexed placeholders are a liability. */
export function renderNotFound(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Page not found</title>
<meta name="robots" content="noindex" />
<style>${styles('#c2410c', 'fresh', { tenantId: '', headline: '', intro: '', serviceAreas: [], phone: '', email: '', showBooking: true, showAssistant: true, published: true })}</style>
</head>
<body>
<div class="hero"><div class="wrap">
  <h1>Nothing here</h1>
  <p class="headline">This page does not exist, or has not been published.</p>
</div></div>
</body>
</html>
`
}
