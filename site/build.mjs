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
const priceTag = (m) =>
  isFree(m) ? '<span class="tag free">Free</span>' : '<span class="tag paid">Paid</span>'

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
</body>
</html>
`

const header = () => `<header>
  <div class="wrap">
    <a class="brand" href="/">Maker<span>Bay</span></a>
    <nav>
      <a href="/modules/assistant">Assistant</a>
      <a href="/#modules">Modules</a>
      <a href="/roadmap">Roadmap</a>
      <a href="/pricing">Pricing</a>
      <a class="btn" href="${APP}">Get started</a>
    </nav>
  </div>
</header>`

const footer = () => `<footer>
  <div class="wrap">
    <p>&copy; 2026 Appa Technologies Pty Ltd</p>
    <nav>
      <a href="/modules/assistant">Assistant</a>
      <a href="/roadmap">Roadmap</a>
      <a href="/changelog">Changelog</a>
      <a href="/pricing">Pricing</a>
      <a href="${APP}">Sign in</a>
    </nav>
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
    <h2>${m.status === 'live' ? 'Try it on your own documents' : 'Start with the assistant today'}</h2>
    <p>${
      m.status === 'live'
        ? 'Free plan, no card required. You will know within ten minutes whether it is useful to you.'
        : `${esc(m.name)} is ${STATUS[m.status].label.toLowerCase()}. The AI assistant is live now, and every module shares the same account.`
    }</p>
    <a class="btn lg" href="${APP}">Get started free</a>
  </div>
</section>`,
  })
}

// ── Roadmap ──────────────────────────────────────────────────────────────

const roadmapPage = () =>
  page({
    title: 'Roadmap - MakerBay',
    description: 'What is live, what is being built, and what comes next - in the order it has to be built.',
    path: '/roadmap',
    body: `<div class="hero">
  <div class="wrap">
    <h1>Roadmap</h1>
    <p class="lead">
      What is live, what is being built, and what comes next. The order is not a
      wish list: each module is placed where it is because of what it needs
      underneath it.
    </p>
    <small>Last updated 23 August 2026</small>
  </div>
</div>

<section>
  <div class="wrap">
    <ol class="road">
${modules
  .map((m) => {
    const s = STATUS[m.status]
    return `      <li class="road-item">
        <span class="tags">${priceTag(m)}<span class="tag ${s.cls}">${s.label}</span></span>
        <h3><a href="/modules/${m.id}">${esc(m.name)}</a></h3>
        <p>${esc(m.tagline)}.</p>
        <p class="note">${esc(m.roadmap.note)}</p>
      </li>`
  })
  .join('\n')}
    </ol>
  </div>
</section>

<section class="soft">
  <div class="wrap">
    <div class="sec-head">
      <h2>What we are not building</h2>
      <p>Saying this out loud is more useful than a longer roadmap.</p>
    </div>
    <div class="faq">
      <h3>Invoicing, tax and bookkeeping</h3>
      <p>Quotes stop at an accepted quote and a deposit. Compliant invoicing, tax
      handling and reconciliation belong in Xero, MYOB or QuickBooks. We would
      rather export to them than compete with them badly.</p>
      <h3>A full CRM</h3>
      <p>Contacts exists so the other modules have somewhere sensible to put a
      customer. If you need pipelines, forecasting and email sequences, use a
      real CRM.</p>
      <h3>A full helpdesk</h3>
      <p>Requests captures and replies. If you already run Zendesk or Freshdesk,
      forward to it instead of moving to us.</p>
      <h3>Review gating</h3>
      <p>Filtering unhappy customers away from public review sites breaks
      Google's policies. We will not build it.</p>
      <h3>Compliance automation</h3>
      <p>Deferred. It is a serious product with serious buyers, and it deserves
      more attention than it would get alongside everything above.</p>
    </div>
  </div>
</section>`,
  })


// ── Pricing ──────────────────────────────────────────────────────────────

const pricingPage = () => {
  const free = modules.filter(isFree)
  const paid = modules.filter((m) => !isFree(m))
  const row = (m) => `        <tr>
          <td><a href="/modules/${m.id}">${esc(m.name)}</a><div class="meta">${esc(m.tagline)}</div></td>
          <td>${priceTag(m)}</td>
          <td><span class="tag ${STATUS[m.status].cls}">${STATUS[m.status].label}</span></td>
        </tr>`

  return page({
    title: 'Pricing - MakerBay',
    description: 'Contacts, Requests and Quotes are free forever. You pay for the AI assistant and Bookings, and only for what you switch on.',
    path: '/pricing',
    body: `<div class="hero">
  <div class="wrap">
    <h1>Pay for capability, not for software</h1>
    <p class="lead">
      Most of MakerBay is free and stays free. You pay for the two modules that
      cost real money to run, and only if you switch them on.
    </p>
    <div class="cta"><a class="btn lg" href="${APP}">Start free</a></div>
    <small>No card to start &middot; Cancel any time</small>
  </div>
</div>

<section>
  <div class="wrap">
    <div class="sec-head">
      <h2>Free forever</h2>
      <p>
        These cost us almost nothing to run, and each one makes the rest more
        useful. There is no trial and no upgrade prompt - they are simply free.
      </p>
    </div>
    <div class="grid">
${free
  .map(
    (m) => `      <a class="card linkcard" href="/modules/${m.id}">
        <span class="tag free">Free</span>
        <h3>${esc(m.name)}</h3>
        <p>${esc(m.tagline)}.</p>
        ${m.freeLimits ? `<p class="meta">Up to ${Object.entries(m.freeLimits).map(([k, v]) => `${Number(v).toLocaleString()} ${k.replace(/PerMonth$/, ' a month')}`).join(' and ')}.</p>` : ''}
      </a>`,
  )
  .join('\n')}
    </div>
  </div>
</section>

<section class="soft" id="paid">
  <div class="wrap">
    <div class="sec-head">
      <h2>What you pay for</h2>
      <p>
        The assistant costs us money every time it answers a question, and
        Bookings is worth real money to a business whose day is a calendar.
        Those two carry the price.
      </p>
    </div>
    <div class="prices">
      <div class="price">
        <h3>Free</h3>
        <div class="amount">$0</div>
        <ul>
          <li>Contacts, Requests and Quotes in full</li>
          <li>200 assistant messages a month</li>
          <li>20 knowledge documents</li>
          <li>Widget, shared page, help centre and API</li>
        </ul>
        <a class="btn ghost" href="${APP}">Start free</a>
      </div>
      <div class="price featured">
        <h3>Pro</h3>
        <div class="amount">$29<span> / month</span></div>
        <ul>
          <li>Everything in Free</li>
          <li>2,000 assistant messages included</li>
          <li>$0.02 per message after that</li>
          <li>500 knowledge documents</li>
          <li>Bookings included</li>
        </ul>
        <a class="btn" href="${APP}">Get started</a>
      </div>
    </div>
    <p class="meta" style="margin-top:20px">Prices in USD, per workspace.</p>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="sec-head"><h2>Every module</h2></div>
    <div class="scroll-x">
      <table class="pricing-table">
        <thead><tr><th>Module</th><th>Cost</th><th>Status</th></tr></thead>
        <tbody>
${[...free, ...paid].map(row).join('\n')}
        </tbody>
      </table>
    </div>
  </div>
</section>

<section class="soft">
  <div class="wrap faq">
    <h2>Questions about price</h2>
    <h3>Is "free forever" really forever?</h3>
    <p>Yes, for the modules marked free. They are cheap for us to run, and a free
    module that fills your customer list is how we grow. If that ever has to
    change, existing workspaces keep what they have.</p>
    <h3>What happens when I hit a limit?</h3>
    <p>You are told in the dashboard, plainly, before anything stops. The caps
    exist to bound our costs, not to push you into upgrading.</p>
    <h3>Do I pay for modules I have not switched on?</h3>
    <p>No. Nothing is billed until you enable it.</p>
    <h3>Can I get my data out?</h3>
    <p>Yes. Contacts exports to CSV whenever you like, on every plan. A customer
    list you cannot take with you is not really yours.</p>
  </div>
</section>

<section class="band">
  <div class="wrap">
    <h2>Start with the free half</h2>
    <p>Contacts, Requests and Quotes cost nothing. Add the assistant when you want it.</p>
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
      current = { version: head[1], date: head[2], entries: [] }
      releases.push(current)
      continue
    }
    if (!current) continue
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

const changelogPage = (releases) => {
  const used = [...new Set(releases.flatMap((r) => r.entries.map((e) => e.area)))]
  const filters = ['all', ...used]
    .map(
      (a) =>
        `<button class="chip-btn${a === 'all' ? ' on' : ''}" data-area="${a}">${
          a === 'all' ? 'Everything' : esc(areaName(a))
        }</button>`,
    )
    .join('\n        ')

  const body = releases
    .map(
      (r) => `      <article class="release" data-areas="${[...new Set(r.entries.map((e) => e.area))].join(' ')}">
        <h2>${esc(r.version)} <span class="when">${longDate(r.date)}</span></h2>
        <ul>
${r.entries
  .map(
    (e) =>
      `          <li data-area="${e.area}"><span class="kind ${e.kind.toLowerCase()}">${e.kind}</span> <span class="area">${esc(
        areaName(e.area),
      )}</span> ${esc(e.text)}</li>`,
  )
  .join('\n')}
        </ul>
      </article>`,
    )
    .join('\n')

  return page({
    title: 'Changelog - MakerBay',
    description: 'Every customer-visible change to MakerBay, newest first.',
    path: '/changelog',
    body: `<div class="hero">
  <div class="wrap">
    <h1>Changelog</h1>
    <p class="lead">Every customer-visible change, newest first. Filter by the part of the product you care about.</p>
  </div>
</div>

<section>
  <div class="wrap">
    <div class="filters" role="group" aria-label="Filter changelog by area">
        ${filters}
    </div>
    <div class="changelog">
${body}
    </div>
    <p class="empty-note" hidden>No entries for that part of the product yet.</p>
  </div>
</section>

<script>
// Filtering is a display concern; every entry is already in the page, so it
// works on a slow connection and the back button behaves.
(function () {
  var buttons = document.querySelectorAll('.chip-btn')
  var note = document.querySelector('.empty-note')
  function apply(area) {
    var shown = 0
    document.querySelectorAll('.release').forEach(function (rel) {
      var any = false
      rel.querySelectorAll('li').forEach(function (li) {
        var match = area === 'all' || li.dataset.area === area
        li.hidden = !match
        if (match) any = true
      })
      rel.hidden = !any
      if (any) shown++
    })
    note.hidden = shown > 0
  }
  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      buttons.forEach(function (o) { o.classList.toggle('on', o === b) })
      apply(b.dataset.area)
      history.replaceState(null, '', b.dataset.area === 'all' ? location.pathname : '#' + b.dataset.area)
    })
  })
  var initial = location.hash.replace('#', '')
  if (initial) {
    var target = document.querySelector('.chip-btn[data-area="' + initial.replace(/[^a-z-]/g, '') + '"]')
    if (target) target.click()
  }
})()
</script>`,
  })
}

// ── Sitemap ──────────────────────────────────────────────────────────────

const sitemap = (paths) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${ORIGIN}${p}</loc></url>`).join('\n')}
</urlset>
`

// ── Build ────────────────────────────────────────────────────────────────

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
await cp(join(here, 'src'), dist, { recursive: true })

const write = async (path, html) => {
  const dir = join(dist, path)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.html'), html, 'utf8')
}

let generated = 0
for (const m of modules) {
  // A hand-written page wins: some modules deserve more than the manifest says.
  if (existsSync(join(here, 'src', 'modules', m.id, 'index.html'))) continue
  await write(`modules/${m.id}`, modulePage(m))
  generated++
}

await write('roadmap', roadmapPage())
await write('pricing', pricingPage())

const releases = parseChangelog(await readFile(join(repo, 'CHANGELOG.md'), 'utf8'))
await write('changelog', changelogPage(releases))

// Inject the generated module grid wherever a page asks for it.
const marker = '<!--modules-grid-->'
for (const file of ['index.html', ...modules.map((m) => `modules/${m.id}/index.html`)]) {
  const path = join(dist, file)
  if (!existsSync(path)) continue
  const html = await readFile(path, 'utf8')
  if (!html.includes(marker)) continue
  await writeFile(path, html.replace(marker, moduleGrid()), 'utf8')
}

await writeFile(
  join(dist, 'sitemap.xml'),
  sitemap(['/', '/pricing', '/roadmap', '/changelog', ...modules.map((m) => `/modules/${m.id}`)]),
  'utf8',
)

console.log(
  `marketing site built: ${modules.length} modules (${generated} generated, ${modules.length - generated} hand-written), ${releases.length} releases`,
)
