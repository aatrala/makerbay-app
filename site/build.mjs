// Builds the marketing site.
//
// Hand-written pages live in src/ and are copied through. Everything that
// describes a module - the homepage grid, the per-module pages, the roadmap -
// is generated from modules/*/module.json, and the changelog page is generated
// from CHANGELOG.md. A module is therefore described in exactly one place.

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const dist = join(here, 'dist')
const ORIGIN = 'https://makerbay.app'
const APP = 'https://app.makerbay.app'

// ── Sources ──────────────────────────────────────────────────────────────

const moduleDirs = await readdir(join(repo, 'modules'), { withFileTypes: true })
const modules = (
  await Promise.all(
    moduleDirs
      .filter((d) => d.isDirectory())
      .map(async (d) => {
        const file = join(repo, 'modules', d.name, 'module.json')
        return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null
      }),
  )
).filter(Boolean)

for (const m of modules) {
  if (!m.marketing?.summary || !m.marketing?.features?.length) {
    throw new Error(`modules/${m.id}/module.json has no usable marketing block.`)
  }
  if (!m.core && !m.pricing) {
    throw new Error(`modules/${m.id}/module.json has no pricing. Set "free" or "paid".`)
  }
}

modules.sort((a, b) => a.roadmap.order - b.roadmap.order)

const isFree = (m) => m.core || m.pricing === 'free'
// Tier pricing, not module pricing: paid capability lives in the Trade plan -
// except Genie, whose full allowance is its own $99 tier (Free/Trade get a
// taster). Saying "In Trade" for Genie contradicted the cards on the same
// page (issue 78).
const priceTag = (m) =>
  isFree(m)
    ? '<span class="tag free">Free</span>'
    : m.id === 'genie'
      ? '<span class="tag paid">Taster in Free & Trade · Full in Genie</span>'
      : '<span class="tag paid">In Trade</span>'

const STATUS = {
  live: { label: 'Available now', cls: 'live' },
  'in-development': { label: 'In development', cls: 'soon' },
  planned: { label: 'Planned', cls: 'soon' },
}

// ── Helpers ──────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const page = ({ title, description, path, body }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${ORIGIN}${path}" />
<meta property="og:type" content="website" />
<link rel="canonical" href="${ORIGIN}${path}" />
<link rel="stylesheet" href="/assets/mb.css" />
</head>
<body>
${header()}
${body}
${footer()}
<script src="https://widget.makerbay.app/widget.js" data-slug="makerbay-hq" data-color="#c2410c" defer></script>
</body>
</html>
`

// Header carries only what a first-time visitor needs; everything else lives
// in the structured footer.
const header = () => `<header>
  <div class="wrap">
    <a class="brand" href="/">Maker<span>Bay</span></a>
    <nav>
      <a href="/#journey">How it works</a>
      <a href="/pricing">Pricing</a>
      <a class="signin" href="${APP}">Sign in</a>
      <a class="btn" href="${APP}">Get started</a>
    </nav>
  </div>
</header>`

let LATEST = ''

const footer = () => `<footer>
  <div class="wrap foot-grid">
    <div class="foot-col foot-brand">
      <a class="brand" href="/">Maker<span>Bay</span></a>
      <p>Modular software for trades and service businesses. Be found, answered and booked — without lifting a finger.</p>
    </div>
    <div class="foot-col">
      <h4>Product</h4>
      <a href="/pricing">Modules & pricing</a>
      <a href="/compare/jobber">MakerBay vs Jobber</a>
      <a href="https://demo.makerbay.app" rel="noopener">Live example page</a>
    </div>
    <div class="foot-col">
      <h4>What's new</h4>
      <a href="/changelog">Changelog</a>
      <a href="/roadmap">Roadmap</a>
    </div>
    <div class="foot-col">
      <h4>Account</h4>
      <a href="${APP}">Sign in</a>
      <a href="${APP}">Create a workspace</a>
    </div>
  </div>
  <div class="wrap foot-legal">
    <p>&copy; 2026 Appa Technologies Pty Ltd${LATEST ? ` &middot; <a href="/changelog">v${LATEST}</a>` : ''}</p>
  </div>
</footer>`

// ── Module grid, injected into any page carrying the marker ──────────────

const moduleCard = (m) => {
  const s = STATUS[m.status]
  return `      <a class="card linkcard" href="/modules/${m.id}">
        <span class="tags">${priceTag(m)}<span class="tag ${s.cls}">${s.label}</span></span>
        <h3>${esc(m.name)}</h3>
        <p>${esc(m.tagline)}.</p>
      </a>`
}

const moduleGrid = () => `<div class="grid">
${modules.map(moduleCard).join('\n')}
    </div>`

// ── Per-module pages ─────────────────────────────────────────────────────

const dependencyNote = (m) => {
  if (!m.dependsOn.length) return ''
  const names = m.dependsOn.map((id) => {
    const dep = modules.find((x) => x.id === id)
    return dep ? `<a href="/modules/${dep.id}">${esc(dep.name)}</a>` : esc(id)
  })
  return `<p class="dep">Builds on ${names.join(' and ')}.</p>`
}

const modulePage = (m) => {
  const s = STATUS[m.status]
  const badge = `<span class="tags">${priceTag(m)}<span class="tag ${s.cls}">${s.label}</span></span>`
  const limits = m.freeLimits
    ? `<p class="dep">Included free, up to ${Object.entries(m.freeLimits)
        .map(([k, v]) => `${Number(v).toLocaleString()} ${k.replace(/PerMonth$/, ' a month').replace(/([A-Z])/g, ' $1').toLowerCase().trim()}`)
        .join(' and ')}.</p>`
    : ''
  const cta =
    m.status === 'live'
      ? `<div class="cta"><a class="btn lg" href="${APP}">Start free</a>
      <a class="btn lg ghost" href="/pricing">See pricing</a></div>`
      : `<div class="cta"><a class="btn lg" href="${APP}">Start with what is live today</a>
      <a class="btn lg ghost" href="/roadmap">See the roadmap</a></div>`

  const faq = m.marketing.faq?.length
    ? `<section class="soft">
  <div class="wrap">
    <div class="sec-head"><h2>Questions</h2></div>
    <div class="faq">
${m.marketing.faq.map((f) => `      <h3>${esc(f.q)}</h3>\n      <p>${esc(f.a)}</p>`).join('\n')}
    </div>
  </div>
</section>`
    : ''

  return page({
    title: `${m.name} - MakerBay`,
    description: m.tagline,
    path: `/modules/${m.id}`,
    body: `<div class="hero">
  <div class="wrap">
    ${badge}
    <h1>${esc(m.name)}</h1>
    <p class="lead">${esc(m.marketing.summary)}</p>
    ${cta}
    <small>${esc(m.marketing.audience)}</small>
  </div>
</div>

<section>
  <div class="wrap">
    <div class="sec-head">
      <h2>What it does</h2>
      ${dependencyNote(m)}
      ${limits}
    </div>
    <div class="grid">
${m.marketing.features
  .map((f) => `      <div class="card">\n        <h3>${esc(f.title)}</h3>\n        <p>${esc(f.body)}</p>\n      </div>`)
  .join('\n')}
    </div>
  </div>
</section>

${faq}

<section class="band">
  <div class="wrap">
    <h2>${
      // The old closer said "Try it on your own documents" on EVERY module
      // page - assistant copy on the Bookings page (issue 90 consult).
      m.status !== 'live'
        ? 'Start with what is live today'
        : m.id === 'assistant'
          ? 'Try it on your own documents'
          : `Switch on ${esc(m.name)} in minutes`
    }</h2>
    <p>${
      m.status === 'live'
        ? 'Free plan, no card required. You will know within ten minutes whether it is useful to you.'
        : `${esc(m.name)} is ${STATUS[m.status].label.toLowerCase()}. Everything live today shares the same account, so you lose nothing by starting now.`
    }</p>
    <a class="btn lg" href="${APP}">Start free</a>
  </div>
</section>`,
  })
}

// ── Roadmap ──────────────────────────────────────────────────────────────

/**
 * Roadmap: a Now / Next / Later board. Now comes from the manifests; Next and
 * Later are editorial - each carries the bar it must clear or the trigger
 * that unparks it, because a roadmap that says WHEN without saying WHY is a
 * wish list.
 */
const NEXT_ITEMS = [
  {
    name: 'Missed-call rescue', price: 'paid',
    body: 'Unanswered call → instant text with your booking link + transcribed voicemail in your inbox, with the job, address and urgency picked out.',
    gate: 'Gate: telephony enablement — built and proven, awaiting carrier access',
  },
  {
    name: 'After-hours voice', price: null,
    body: 'A phone agent that answers when you cannot, grounded in the same knowledge as your chat assistant.',
    gate: 'Gate: must beat our published latency bar on real calls — measured, not promised',
  },
]
const LATER_ITEMS = [
  {
    name: 'Local directory',
    body: 'Find a MakerBay business by suburb and trade. Only worth building at density — a thin directory helps nobody.',
    gate: 'Trigger: enough complete, bookable businesses per area',
  },
  {
    name: 'In-call payments',
    body: 'Take a card securely during a phone call — after voice itself earns its place.',
    gate: 'Trigger: voice live + a PCI-safe capture path',
  },
  {
    name: 'Calendar sync',
    body: 'Two-way Google Calendar. We would rather ship a diary that is correct than a sync that is nearly right.',
    gate: 'Trigger: demand from paying workspaces',
  },
]
const NEVER_ITEMS = [
  { name: 'Bookkeeping & tax', body: 'Simple invoices yes; ledgers and tax belong in Xero, MYOB or QuickBooks.' },
  { name: 'Review gating', body: "Routing only happy customers to Google breaks Google's rules. Never." },
  { name: 'A full CRM / helpdesk', body: "If you need pipelines or Zendesk, use them — we'll hold your customer list honestly." },
  { name: 'Pay-for-placement', body: 'If the directory ships, nobody buys their way above a better business.' },
]

const roadmapPage = () => {
  const live = modules.filter((m) => m.status === 'live')
  const nowCards = live
    .map((m) => `      <div class="rcard"><h3><a href="/modules/${m.id}">${esc(m.name)}</a> ${priceTag(m)}</h3><p>${esc(m.tagline)}.</p></div>`)
    .join('\n')
  const nextCards = NEXT_ITEMS
    .map((i) => `      <div class="rcard"><h3>${esc(i.name)}${i.price === 'paid' ? ' <span class="tag paid">In Trade</span>' : ''}</h3><p>${i.body}</p><div class="gate">${esc(i.gate)}</div></div>`)
    .join('\n')
  const laterCards = LATER_ITEMS
    .map((i) => `      <div class="rcard"><h3>${esc(i.name)}</h3><p>${esc(i.body)}</p><div class="gate">${esc(i.gate)}</div></div>`)
    .join('\n')
  const neverCards = NEVER_ITEMS
    .map((i) => `      <div class="never-card"><h3>${esc(i.name)}</h3><p>${esc(i.body)}</p></div>`)
    .join('\n')

  return page({
    title: 'Roadmap - MakerBay',
    description: 'Now, next and later - with the bar each item must clear before it ships, and the things we will not build at all.',
    path: '/roadmap',
    body: `<div class="hero">
  <div class="wrap">
    <h1>Roadmap</h1>
    <p class="lead">
      Be found &middot; Be answered &middot; Get booked &middot; Get paid — without lifting a finger.
      Three honest columns: <strong>Now</strong> is live and in the changelog. <strong>Next</strong> is
      designed in the open, each with the bar it must pass. <strong>Later</strong> is parked behind an
      explicit trigger. And below all of it, what we will not build at all.
    </p>
    <small>Updated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} &middot; ${live.length} modules live</small>
  </div>
</div>

<section>
  <div class="wrap board">
    <div class="col now">
      <h2><span class="dot"></span>Now — live</h2>
      <p class="colsub">Shipped, verified, in the <a href="/changelog">changelog</a>.</p>
${nowCards}
    </div>
    <div class="col next">
      <h2><span class="dot"></span>Next — in design</h2>
      <p class="colsub">A public bar to clear before each one ships.</p>
${nextCards}
    </div>
    <div class="col later">
      <h2><span class="dot"></span>Later — parked on purpose</h2>
      <p class="colsub">Each has a written trigger. Nothing ships quietly.</p>
${laterCards}
    </div>
  </div>
</section>

<section class="band never-band">
  <div class="wrap">
    <h2>What we are not building</h2>
    <p>Published so you can plan around us. These are commitments, not gaps.</p>
    <div class="never-grid">
${neverCards}
    </div>
  </div>
</section>`,
  })
}


// ── Pricing ──────────────────────────────────────────────────────────────

const pricingPage = () => {
  const free = modules.filter(isFree)
  const row = (m) => `        <tr>
          <td><a href="/modules/${m.id}">${esc(m.name)}</a><div class="meta">${esc(m.tagline)}</div></td>
          <td>${priceTag(m)}</td>
          <td><span class="tag ${STATUS[m.status].cls}">${STATUS[m.status].label}</span></td>
        </tr>`

  return page({
    title: 'Pricing - MakerBay',
    description: 'Free runs your business online. Trade at $29/month switches everything on. Genie at $99/month runs it from a conversation. Same prices worldwide, month to month, no contracts.',
    path: '/pricing',
    body: `<div class="hero">
  <div class="wrap">
    <h1>Three plans. No homework.</h1>
    <p class="lead">
      You should not need a spreadsheet to buy software. Free runs your business
      online. Trade switches everything on for what competitors charge to start.
      Genie runs it from a conversation. That is the whole decision.
    </p>
    <div class="cta"><a class="btn lg" href="${APP}">Start free</a></div>
    <small>Same prices worldwide, in USD &middot; Month to month &middot; No card to start &middot; Cancel any time</small>
  </div>
</div>

<section>
  <div class="wrap">
    <div class="prices tiers">
      <div class="price">
        <h3>Free</h3>
        <div class="amount">$0</div>
        <p class="tier-pitch">Run your business online. Actually free.</p>
        <ul>
          <li>Your page — services, prices, hours, reviews, booking button</li>
          <li>Contacts, Requests inbox and public help centre</li>
          <li>200 quotes a month, with one-click invoices</li>
          <li>Card payments via Stripe — we add no fee</li>
          <li>Get found: the Google Business Profile checklist</li>
          <li>200 assistant messages a month &middot; 20 documents</li>
          <li>20 bookings and 20 review invites a month</li>
        </ul>
        <a class="btn ghost" href="${APP}">Start free</a>
      </div>
      <div class="price featured">
        <h3>Trade</h3>
        <div class="amount">$29<span> / month</span></div>
        <p class="tier-pitch">Everything switched on, for what Jobber charges to start.</p>
        <ul>
          <li>Everything in Free, plus:</li>
          <li><strong>Unlimited</strong> bookings, review invites, quotes and invoices</li>
          <li>2,000 assistant messages a month</li>
          <li>Your page on <strong>your own domain</strong></li>
          <li>Missed-call rescue, when it reaches your region</li>
          <li>Booking reminders, review asks, the whole loop</li>
        </ul>
        <a class="btn" href="${APP}">Get started</a>
        <p class="meta" style="margin-top:12px">$290 a year — 2 months free.</p>
        <p class="meta founding">Founding offer: the first 100 workspaces pay <strong>$19/mo</strong> — and keep that price for as long as they stay.</p>
      </div>
      <div class="price">
        <h3>Genie</h3>
        <div class="amount">$99<span> / month</span></div>
        <p class="tier-pitch">An office manager for less than one billable hour a week.</p>
        <ul>
          <li>Everything in Trade, plus:</li>
          <li><strong>Genie</strong>: 2,500 messages a month — briefings, answers and actions from a conversation on your phone</li>
          <li>Send quotes and invoices, manage bookings, block out time — every action behind a card only you confirm, on your activity trail</li>
          <li>After-hours voice answering, when it passes our latency bar</li>
          <li>Priority support — your tickets answered first</li>
        </ul>
        <a class="btn ghost" href="${APP}">Get started</a>
      </div>
    </div>
    <p class="meta" style="margin-top:20px">
      All prices in USD, the same everywhere. Pay-as-you-go applies only to things
      that cost us money per use: assistant messages beyond your allowance ($0.02
      each, opt-in — the default is a polite stop), and voice minutes when voice
      ships. Never per booking, per quote or per invoice — we will not tax your
      own success. Card payments carry no MakerBay fee — Stripe's rate is Stripe's.
    </p>
  </div>
</section>

<section class="soft">
  <div class="wrap">
    <div class="sec-head">
      <h2>A taste of Genie on every plan</h2>
      <p>
        Every plan includes Genie today: Free workspaces get 25 Genie messages a
        month and Trade gets 250 — enough for the morning briefing habit. Running
        the whole business by chat is what the $99 tier is for.
      </p>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="sec-head"><h2>Every module, and where it lives</h2></div>
    <div class="scroll-x">
      <table class="pricing-table">
        <thead><tr><th>Module</th><th>Plan</th><th>Status</th></tr></thead>
        <tbody>
${[...free, ...modules.filter((m) => !isFree(m))].map(row).join('\n')}
        </tbody>
      </table>
    </div>
  </div>
</section>

<section class="soft">
  <div class="wrap faq">
    <h2>Questions about price</h2>
    <h3>Is "free forever" really forever?</h3>
    <p>Yes. Everything in the Free tier stays free for existing workspaces, full stop. A free
    plan that fills your customer list is how we grow.</p>
    <h3>Why are bookings and review invites capped on Free?</h3>
    <p>Honestly: not because they cost us much — because if MakerBay is taking 20+ bookings a
    month for you, it is running your day, and $29 is a fair price for that. The caps on
    assistant messages are different: those genuinely cost us money per message.</p>
    <h3>What happens when I hit a limit?</h3>
    <p>You are told in the dashboard, plainly, before anything stops. Message overage is opt-in;
    the default is a polite stop, never a surprise bill.</p>
    <h3>How does annual billing work?</h3>
    <p>$290 a year — two months free. Annual plans pause politely at the message allowance
    instead of billing overage, so a yearly invoice can never surprise you. Month to month
    stays the headline; there are no contracts and no cancellation calls.</p>
    <h3>Do prices differ by country?</h3>
    <p>No. Same prices worldwide, in USD. Stripe handles your local card and currency conversion.</p>
    <h3>Can I get my data out?</h3>
    <p>Yes. Contacts exports to CSV whenever you like, on every plan. A customer list you cannot
    take with you is not really yours.</p>
  </div>
</section>

<section class="band">
  <div class="wrap">
    <h2>Start with the free half</h2>
    <p>Your page, quotes, payments and the inbox cost nothing. Switch on Trade when the caps
    start to matter.</p>
    <a class="btn lg" href="${APP}">Create your workspace</a>
  </div>
</section>`,
  })
}

// ── Changelog ────────────────────────────────────────────────────────────

const AREAS = new Set(['platform', ...modules.map((m) => m.id)])
const KINDS = ['Added', 'Changed', 'Fixed', 'Security']

/** Parses CHANGELOG.md into releases so the page can filter without a build step per filter. */
function parseChangelog(md) {
  const releases = []
  let current = null
  // Split on either ending. Git checks this file out with CRLF on Windows, and
  // `.` in a JS regex does not match \r, so every entry line silently failed to
  // parse while the headings still matched: releases rendered with no content.
  for (const raw of md.split(/\r?\n/)) {
    const head = raw.match(/^##\s+(\S+)\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/)
    if (head) {
      current = { version: head[1], date: head[2], entries: [], headline: '', standfirst: '' }
      releases.push(current)
      continue
    }
    if (!current) continue
    // Optional editorial line: > **Headline** — standfirst
    const ed = raw.match(/^>\s+\*\*(.+?)\*\*\s+[—-]\s+(.*)$/)
    if (ed && current.entries.length === 0) {
      current.headline = ed[1].trim()
      current.standfirst = ed[2].trim()
      continue
    }
    const entry = raw.match(/^-\s+(\w+)\s+`([a-z-]+)`\s+(.*)$/)
    if (entry) {
      const [, kind, area, text] = entry
      if (!KINDS.includes(kind)) throw new Error(`Unknown changelog kind "${kind}" in ${current.version}`)
      if (!AREAS.has(area)) throw new Error(`Unknown changelog area "${area}" in ${current.version}`)
      current.entries.push({ kind, area, text: text.trim() })
      continue
    }
    // Continuation line of the previous entry.
    if (raw.startsWith('  ') && raw.trim() && current.entries.length) {
      const last = current.entries[current.entries.length - 1]
      last.text += ' ' + raw.trim()
    }
  }
  // A release with no entries means the parser stopped understanding the file.
  // Failing the build is far better than publishing an empty changelog.
  const empty = releases.filter((r) => r.entries.length === 0)
  if (empty.length) {
    throw new Error(
      `Changelog releases parsed with no entries: ${empty.map((r) => r.version).join(', ')}. ` +
      'Check the entry format: "- Kind `area` text".',
    )
  }
  if (releases.length === 0) throw new Error('No releases parsed from CHANGELOG.md.')
  return releases
}

const longDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

const areaName = (id) => (id === 'platform' ? 'Platform' : modules.find((m) => m.id === id)?.name ?? id)

const KIND_LABEL = { Added: 'New', Changed: 'Better', Fixed: 'Fixed', Security: 'Security' }
const KIND_CLS = { Added: '', Changed: 'chg', Fixed: 'fix', Security: 'fix' }

const monthName = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const shortDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** A short pill from an entry: kind + the area it touched. */
const pill = (e) =>
  `<span class="pill ${KIND_CLS[e.kind] ?? ''}"><b>${KIND_LABEL[e.kind] ?? e.kind}</b> ${esc(areaName(e.area))}</span>`

const changelogPage = (releases) => {
  // Group by month, newest first (releases already arrive newest-first).
  const months = []
  for (const r of releases) {
    const key = r.date.slice(0, 7)
    let m = months.find((x) => x.key === key)
    if (!m) { m = { key, label: monthName(r.date), releases: [] }; months.push(m) }
    m.releases.push(r)
  }

  const body = months
    .map(
      (m) => `  <div class="month">
    <h2>${esc(m.label)}</h2>
    <div class="tl">
${m.releases
  .map((r) => {
    const major = r.entries.length >= 4
    const title = r.headline || `Release ${r.version}`
    const pills = [...new Set(r.entries.slice(0, 4).map(pill))].join('\n')
    const all = r.entries
      .map((e) => `            <li><b>${esc(areaName(e.area))}</b> — ${esc(e.text)}</li>`)
      .join('\n')
    return `      <article class="rel${major ? ' major' : ''}">
        <div class="rel-head"><h3>${esc(title)}</h3>
          <span class="v">${esc(r.version)}</span><span class="when">${shortDate(r.date)}</span></div>
        ${r.standfirst ? `<p class="sum">${esc(r.standfirst)}</p>` : ''}
        <div class="pills">
          ${pills}
        </div>
        <details><summary>All changes in ${esc(r.version)}</summary>
          <ul>
${all}
          </ul>
        </details>
      </article>`
  })
  .join('\n')}
    </div>
  </div>`,
    )
    .join('\n')

  return page({
    title: 'Changelog - MakerBay',
    description: 'Every customer-visible change, in the open. Nothing ships without an entry here.',
    path: '/changelog',
    body: `<div class="hero">
  <div class="wrap">
    <h1>Changelog</h1>
    <p class="lead">Every customer-visible change, in the open. Nothing ships without an entry
    here — a promise you can hold us to.</p>
    <div class="cl-stats">
      <div><b>${releases.length}</b><span>releases</span></div>
      <div><b>${modules.filter((m) => m.status === 'live').length}</b><span>modules live</span></div>
      <div><b>${monthName(releases[0].date)}</b><span>latest release</span></div>
    </div>
  </div>
</div>

<section>
  <div class="wrap cl-wrap">
${body}
  </div>
</section>`,
  })
}

// ── Sitemap ──────────────────────────────────────────────────────────────

const sitemap = (paths) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${ORIGIN}${p}</loc></url>`).join('\n')}
</urlset>
`

// ── Compare: MakerBay vs Jobber ─────────────────────────────────────────
// One honest mechanics comparison (issue 84). Their numbers are their
// published prices; we say when they are the better pick, because a
// comparison page you can't trust is worth less than no page.

const comparePage = () =>
  page({
    title: 'MakerBay vs Jobber - an honest comparison',
    description:
      'Jobber starts at $39/month for one user with AI answering as a paid add-on. MakerBay is $29 flat with the assistant included, and a free plan that is not a trial. The mechanics, side by side.',
    path: '/compare/jobber',
    body: `
<div class="hero">
  <div class="wrap">
    <h1>MakerBay vs Jobber</h1>
    <p class="lead">
      Jobber is good software. This page is not a hit piece - it is the
      pricing mechanics side by side, because the mechanics are where the
      real difference lives. Their numbers are their published prices
      (mid-2026); check them yourself at jobber.com/pricing.
    </p>
  </div>
</div>

<section>
  <div class="wrap">
    <div class="sec-head"><h2>The mechanics, side by side</h2></div>
    <div class="scroll-x">
      <table class="pricing-table">
        <thead><tr><th></th><th>Jobber</th><th>MakerBay</th></tr></thead>
        <tbody>
          <tr><td>Entry price</td><td>$39/mo (Core, billed monthly), one user</td><td>$29/mo flat (Trade) - or $0 forever on Free</td></tr>
          <tr><td>Free plan</td><td>No - 14-day trial only</td><td>Yes - a real plan with real allowances, no clock</td></tr>
          <tr><td>AI that answers customers</td><td>AI Receptionist is a paid add-on (~$99/mo)</td><td>Included on every plan - grounded in your documents, with sources shown</td></tr>
          <tr><td>Extra team members</td><td>+$29/user/mo</td><td>Solo-first today; no per-seat pricing</td></tr>
          <tr><td>Tier jumps</td><td>$39 &rarr; $119 &rarr; $199 as features unlock</td><td>$29 switches everything on; $99 adds the Genie copilot</td></tr>
          <tr><td>Card payment fees</td><td>Processing via Jobber Payments</td><td>We add no fee - Stripe's rate is Stripe's</td></tr>
          <tr><td>Contract</td><td>Monthly or annual</td><td>Month to month; cancel from the billing page, not a phone call</td></tr>
          <tr><td>Your data</td><td>Export available</td><td>CSV export on every plan - <a href="/roadmap">the roadmap pledges it publicly</a></td></tr>
        </tbody>
      </table>
    </div>
    <p class="meta" style="margin-top:14px">All MakerBay prices in USD, the same everywhere.</p>
  </div>
</section>

<section class="soft">
  <div class="wrap">
    <div class="sec-head"><h2>When Jobber is the better pick</h2>
    <p>
      Honestly: if you run a crew of five with dispatch, GPS tracking, and
      QuickBooks sync as daily needs, Jobber is built for that today and
      MakerBay is not. MakerBay is built for the solo operator or small team
      whose real problem is being found, answered and booked while their
      hands are full - with an AI assistant included instead of sold as an
      add-on.
    </p></div>
  </div>
</section>

<section class="band">
  <div class="wrap">
    <h2>Try the difference in ten minutes</h2>
    <p>Free plan, no card, no trial clock. If it isn't useful, you've lost ten minutes.</p>
    <a class="btn lg" href="${APP}">Start free</a>
  </div>
</section>`,
  })

// ── Build ────────────────────────────────────────────────────────────────

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
await cp(join(here, 'src'), dist, { recursive: true })

const write = async (path, html) => {
  const dir = join(dist, path)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.html'), html, 'utf8')
}

const releases = parseChangelog(await readFile(join(repo, 'CHANGELOG.md'), 'utf8'))
LATEST = releases[0].version

let generated = 0
for (const m of modules) {
  // A hand-written page wins: some modules deserve more than the manifest says.
  if (existsSync(join(here, 'src', 'modules', m.id, 'index.html'))) continue
  await write(`modules/${m.id}`, modulePage(m))
  generated++
}

await write('roadmap', roadmapPage())
await write('pricing', pricingPage())

await write('changelog', changelogPage(releases))
await write('compare/jobber', comparePage())

// Inject the generated module grid wherever a page asks for it.
const marker = '<!--modules-grid-->'
for (const file of ['index.html', ...modules.map((m) => `modules/${m.id}/index.html`)]) {
  const path = join(dist, file)
  if (!existsSync(path)) continue
  const html = await readFile(path, 'utf8')
  let out = html
  if (out.includes(marker)) out = out.replace(marker, moduleGrid())
  out = out.replace(
    '<p>© 2026 Appa Technologies Pty Ltd</p>',
    `<p>© 2026 Appa Technologies Pty Ltd · <a href="/changelog">v${LATEST}</a></p>`,
  )
  if (out !== html) await writeFile(path, out, 'utf8')
}

// Cache-bust every asset link with the release version (issue 92): browsers
// heuristically cache /assets/* for hours, so a shipped HTML change can
// render against a stale stylesheet - which is exactly how the hero demo
// appeared as unstyled text on the founder's machine. A ?v= per release
// makes every browser fetch the matching CSS/JS the moment a page updates.
const walk = async (dir) => {
  const { readdir } = await import('node:fs/promises')
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (e.name.endsWith('.html')) out.push(p)
  }
  return out
}
for (const file of await walk(dist)) {
  const html = await readFile(file, 'utf8')
  const out = html
    .replaceAll('/assets/mb.css', `/assets/mb.css?v=${LATEST}`)
    .replaceAll('/assets/hero-demo.js', `/assets/hero-demo.js?v=${LATEST}`)
  if (out !== html) await writeFile(file, out, 'utf8')
}

await writeFile(
  join(dist, 'sitemap.xml'),
  sitemap(['/', '/pricing', '/roadmap', '/changelog', ...modules.map((m) => `/modules/${m.id}`)]),
  'utf8',
)

console.log(
  `marketing site built: ${modules.length} modules (${generated} generated, ${modules.length - generated} hand-written), ${releases.length} releases`,
)
