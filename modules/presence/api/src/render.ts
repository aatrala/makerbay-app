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

import type { AssistantView, HoursView, PresenceConfigRow, ServiceView } from './db'

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
  /**
   * Where this page canonically lives. Defaults to makerbay.app/p/{slug};
   * an active custom domain takes over as the canonical home, and the free
   * page points at it - same content, one address in the index.
   */
  canonicalUrl?: string
  /** The instant of rendering, passed in so open/closed is testable. */
  now: Date
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
      priceCurrency: 'AUD',
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

const styles = (brand: string) => `
  :root { --brand: ${esc(brand)}; --ink: #1c1917; --body: #57534e; --muted: #a8a29e;
    --line: #e7e5e4; --ok: #15803d; --ok-sub: #dcfce7; --bg: #faf9f7; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', sans-serif;
    color: var(--ink); background: #fff; line-height: 1.6; font-size: 17px; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 0 22px; }
  .hero { padding: 44px 0 30px; }
  .hero img { width: 100%; max-height: 320px; object-fit: cover; border-radius: 14px; margin-bottom: 24px; }
  h1 { font-size: clamp(28px, 5vw, 40px); line-height: 1.15; letter-spacing: -0.02em; }
  .headline { color: var(--body); font-size: 19px; margin-top: 6px; }
  .areas { color: var(--muted); font-size: 14.5px; margin-top: 10px; }
  .status { display: inline-block; margin-top: 14px; padding: 4px 12px; border-radius: 20px;
    font-size: 13.5px; font-weight: 600; }
  .status.open { background: var(--ok-sub); color: var(--ok); }
  .status.closed { background: var(--bg); color: var(--body); border: 1px solid var(--line); }
  .cta { display: flex; gap: 10px; flex-wrap: wrap; margin: 26px 0 8px; }
  .btn { display: inline-block; background: var(--brand); color: #fff; text-decoration: none;
    padding: 13px 24px; border-radius: 9px; font-weight: 650; font-size: 16px; }
  .btn.ghost { background: transparent; color: var(--brand); box-shadow: inset 0 0 0 1.5px var(--brand); }
  section { padding: 26px 0; border-top: 1px solid var(--line); }
  h2 { font-size: 20px; letter-spacing: -0.01em; margin-bottom: 12px; }
  .intro { color: var(--body); white-space: pre-wrap; }
  ul.services { list-style: none; }
  ul.services li { display: flex; gap: 14px; align-items: baseline; padding: 11px 0;
    border-bottom: 1px solid var(--line); }
  ul.services li:last-child { border-bottom: none; }
  .svc-name { font-weight: 600; }
  .svc-desc { color: var(--muted); font-size: 14.5px; }
  .svc-meta { margin-left: auto; text-align: right; white-space: nowrap; color: var(--body); font-size: 15px; }
  table.hours { border-collapse: collapse; }
  table.hours td { padding: 4px 18px 4px 0; color: var(--body); font-size: 15.5px; }
  table.hours td:first-child { color: var(--ink); font-weight: 600; min-width: 110px; }
  .contact a { color: var(--brand); text-decoration: none; font-weight: 600; }
  .rev-sum { color: var(--body); margin-bottom: 14px; }
  .rev-stars { color: #f59e0b; letter-spacing: 1px; }
  blockquote.rev { margin: 0 0 16px; padding: 0 0 16px; border-bottom: 1px solid var(--line); }
  blockquote.rev:last-of-type { border-bottom: none; padding-bottom: 0; }
  blockquote.rev p { color: var(--body); }
  blockquote.rev cite { color: var(--muted); font-style: normal; font-size: 14.5px; }
  footer { border-top: 1px solid var(--line); margin-top: 18px; padding: 26px 0 44px; }
  footer p { color: var(--muted); font-size: 13.5px; }
  footer a { color: var(--muted); }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #f5f5f4; --body: #d6d3d1; --muted: #a8a29e; --line: #292524; --bg: #292524; }
    body { background: #1c1917; }
  }
`

const cash = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`

export function renderPage(input: PageInput): string {
  const { config, businessName, slug, services, hours, assistant, hasKnowledge, bookingEnabled } = input
  const directive = indexDirective(input)
  const title = businessName
  const description = (config.intro.trim() || config.headline || businessName).slice(0, 155)
  const state = hours ? openState(hours, input.now) : undefined

  // The page never shows a control that does nothing (spec §3). Each block
  // renders only when the module behind it can actually respond.
  const bookHref = `${CHAT_ORIGIN}/booking?slug=${encodeURIComponent(slug)}`
  const askHref = `${CHAT_ORIGIN}/${encodeURIComponent(slug)}`
  const showBooking = bookingEnabled && config.showBooking && services.length > 0
  const showAssistant = hasKnowledge && config.showAssistant

  const cta = [
    showBooking ? `<a class="btn" href="${bookHref}">Book a time</a>` : '',
    !showBooking && config.phone
      ? `<a class="btn" href="tel:${esc(config.phone)}">Call ${esc(config.phone)}</a>`
      : '',
    showAssistant ? `<a class="btn ghost" href="${askHref}">Ask a question</a>` : '',
  ].filter(Boolean).join('\n      ')

  const servicesBlock = services.length
    ? `<section>
    <h2>Services</h2>
    <ul class="services">
${services
  .map(
    (s) => `      <li>
        <span><span class="svc-name">${esc(s.name)}</span>${s.description ? `<br /><span class="svc-desc">${esc(s.description)}</span>` : ''}</span>
        <span class="svc-meta">${s.priceCents != null && s.priceCents > 0 ? `${cash(s.priceCents)} · ` : ''}${s.durationMinutes} min</span>
      </li>`,
  )
  .join('\n')}
    </ul>
  </section>`
    : ''

  const hoursBlock = hours && Object.values(hours.hours).some((w) => w?.length)
    ? `<section>
    <h2>Hours</h2>
    <table class="hours">
${(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const)
  .map((d) => {
    const w = hours.hours[d]
    return `      <tr><td>${DAY_LABEL[d]}</td><td>${w?.length ? w.map((x) => `${x.from}–${x.to}`).join(', ') : 'Closed'}</td></tr>`
  })
  .join('\n')}
    </table>
  </section>`
    : ''

  // Visible words only, no review structured data: Google treats review
  // markup about your own business on your own page as self-serving and
  // ignores it at best. The words still persuade the humans who land here.
  const reviewsBlock = input.reviews && input.reviews.count > 0
    ? `<section>
    <h2>What customers say</h2>
    <p class="rev-sum"><span class="rev-stars">${'★'.repeat(Math.round(input.reviews.average))}</span> ${input.reviews.average.toFixed(1)} from ${input.reviews.count} review${input.reviews.count === 1 ? '' : 's'}</p>
${input.reviews.items
  .slice(0, 5)
  .map(
    (r) => `    <blockquote class="rev">
      <span class="rev-stars">${'★'.repeat(r.rating)}</span>
      ${r.text ? `<p>${esc(r.text)}</p>` : ''}
      ${r.name ? `<cite>${esc(r.name)}</cite>` : ''}
    </blockquote>`,
  )
  .join('\n')}
  </section>`
    : ''

  const contactBits = [
    config.phone ? `<a href="tel:${esc(config.phone)}">${esc(config.phone)}</a>` : '',
    config.email ? `<a href="mailto:${esc(config.email)}">${esc(config.email)}</a>` : '',
    config.websiteUrl?.trim() ? `<a href="${esc(config.websiteUrl.trim())}" rel="noopener">${esc(config.websiteUrl.trim().replace(/^https?:\/\//, ''))}</a>` : '',
  ].filter(Boolean)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
${directive === 'noindex' ? '<meta name="robots" content="noindex, follow" />' : ''}
<link rel="canonical" href="${esc(input.canonicalUrl ?? `${PAGE_ORIGIN}/p/${slug}`)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(input.canonicalUrl ?? `${PAGE_ORIGIN}/p/${slug}`)}" />
<meta property="og:type" content="website" />
${config.photoKey ? `<meta property="og:image" content="${PHOTO_ORIGIN}/${esc(config.photoKey)}" />` : ''}
<script type="application/ld+json">${localBusinessJsonLd(input)}</script>
<style>${styles(assistant.brandColor)}</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    ${config.photoKey ? `<img src="${PHOTO_ORIGIN}/${esc(config.photoKey)}" alt="${esc(businessName)}" />` : ''}
    <h1>${esc(businessName)}</h1>
    ${config.headline ? `<p class="headline">${esc(config.headline)}</p>` : ''}
    ${config.serviceAreas.length ? `<p class="areas">Serving ${esc(config.serviceAreas.join(', '))}</p>` : ''}
    ${state ? `<span class="status ${state.open ? 'open' : 'closed'}">${esc(state.label)}</span>` : ''}
    <div class="cta">
      ${cta}
    </div>
  </div>

  ${config.intro.trim() ? `<section><h2>About</h2><p class="intro">${esc(config.intro.trim())}</p></section>` : ''}
  ${servicesBlock}
  ${reviewsBlock}
  ${hoursBlock}
  ${contactBits.length ? `<section class="contact"><h2>Contact</h2><p>${contactBits.join(' · ')}</p></section>` : ''}
</div>
<footer>
  <div class="wrap"><p>Page by <a href="${PAGE_ORIGIN}">MakerBay</a></p></div>
</footer>
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
<style>${styles('#c2410c')}</style>
</head>
<body>
<div class="wrap"><div class="hero">
  <h1>Nothing here</h1>
  <p class="headline">This page does not exist, or has not been published.</p>
</div></div>
</body>
</html>
`
}
