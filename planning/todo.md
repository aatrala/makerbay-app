# MakerBay — Issue Tracker & Status Board

Location: `makerbay-app/planning/todo.md` (inside the app repo).
Updated 2026-08-25. One section per issue with a manual test you can run.

Legend: ✅ live and verified · 🔶 live, founder test welcome · ⏳ in
progress · 💬 awaiting your decision · ⛔ blocked · 📋 spec'd/deferred

## Issues 1-25 (earlier sessions, backfilled from the founder's ledger)

| # | Issue | Status |
|---|-------|--------|
| 1-2 | Memorable + editable slugs | ✅ Shipped (see also 29, 41) |
| 3-5 | Page design, no separate assistant page, preview + themes | ✅ Shipped |
| 6 | Booking/availability/payment on page, mobile, checklist | ✅ Shipped. Booking deposits on the page stay deferred until a booking can be paid-before-created |
| 7 | Header/footer cleanup | ✅ Shipped |
| 8 | Quotes currency + theme preview | ✅ Shipped (preview now prefix-aware, see 37) |
| 9 | greenlightyourapp import failure | ✅ Fixed then (10.5k chars via llms.txt); superseded by 43 - all its JS-built pages now import via the headless renderer |
| 10 | Similar-issue sweep | ✅ Currency plumbing, import limits, greetings, accent on every surface |
| 11-13 | Site priority order, FAQ categories, screenshots, personas | ✅ Shipped |
| 14 | Demo assistant knowledge/defaults/theme/booking chat | ✅ Shipped + verified. The then-pending manual busy blocks have since shipped (2026-08-24): diary → "Block out time" |
| 15 | Assistant on makerbay.app | ✅ Live (MakerBay HQ workspace powers it) |
| 16 | Marketplace | 📋 Spec'd, deferred to ~1,000 customers as you directed |
| 17 | Demo theme = site theme | ✅ Shipped (#c2410c everywhere) |
| 18 | Tier pricing + PAYG | ✅ Live; Genie tier added on top (see 38/billing) |
| 19 | Voice / Nova Sonic | ⛔ Probe ready; blocked on your ~30-min Connect console setup + 10 test calls (docs/probe-voice-latency.md, DID +1 414 219 1295) |
| 20 | Admin panel supportability | ✅ P0 + P1 + overhaul all shipped (see 46, 48b): find-by-email, tenant 360, password resets, kill switch, suppression viewer, conversation viewer, audit log, privacy scripts, dashboard |
| 21 | Docs/README refresh | ✅ Shipped |
| 22 | Roadmap/changelog redesign | ✅ Variant B live |
| 23 | Chat greeting / blue page / unclickable links | ✅ All fixed + verified |
| 24 | Help centre access/theming | ✅ Accent sync shipped; discoverability finished under 42 (own tab) |
| 25 | Slug editing | ✅ Works, UI-verified; discoverability link added |

## Issues 26-43 (current stream)

### 26 — Assistant widget shows who you're chatting with ✅
Business identity header (photo, name, open/closed label) + quick chips.
**Test:** open chat.makerbay.app/?slug=makerbay-demo → header shows
"Southside Plumbing" with photo; chips row under the greeting.

### 27 — Sidebar redesign (Variant A) + phase 2 bottom nav ✅
Grouped Work/Grow nav, icons, account popover, tabs above screens; on
phones a bottom bar: Requests (badge), Diary, Quotes, More.
**Test:** app.makerbay.app on desktop → 12-row sidebar; on your phone →
bottom bar with a count badge on Requests.

### 28 — App version visible, linking to release notes ✅
**Test:** app → account popover (bottom of sidebar) → "v2.14.0 ·
Changelog"; marketing site footer shows the version too.

### 29 — Edit the page URL slug ✅
**Test:** app → Your page → Your address → Edit → type a new address →
availability check runs as you type.

### 30 — Help centre redesign + auto-generated article meta ✅
**Test:** help.makerbay.app/makerbay-demo → grouped articles with real
titles; search appears at 4+ articles.

### 31 — Marketing screenshots consistent theming ✅
**Test:** makerbay.app → screenshots share one palette.

### 32 — Booking form broken inside chat widget ✅
Global CSS leak fixed (scoped to the composer).
**Test:** chat → "Book a time" → pick service/day/slot → the your-details
form fields stack vertically.

### 33 — Share page + QR codes ✅
**Test:** app → Your page → Share → per-network steps + share buttons;
QR blocks with print-size download on Your page and Share.

### 34 — Connect domain flow broken ✅
URL normalization, alias release on remove, honest alias-busy message,
unique caller references. Proven with demo.makerbay.app remove→re-add.
**Test:** https://demo.makerbay.app loads the Southside Plumbing page.

### 35 — Hide live-billing text in production ✅
**Test:** sidebar shows a TEST BILLING badge only while Stripe is in
test mode; no live-mode banner ever.

### 36 — Genie not visible/accessible ✅
Root cause: /me ignored manual grants. Fixed; Genie v1 shipped.
**Test:** app → Grow → Genie → ask "give me my morning briefing".

### 37 — Documents start at 001 + prefix ✅
Counters seed zero; per-tenant docPrefix (SP → SP-Q-001, SP-INV-001)
on emails, public pages, Stripe lines, Genie. Existing numbers kept.
**Test:** Quotes → Price list → Quote settings → "Document prefix";
create a draft quote → list shows SP-Q-00x.

### 38 — Dynamic options in assistant + Genie; Genie missing for aatrala ✅
Genie now appears for EVERY account (taster: 25/mo Free, 250 Trade;
your account carries a full 2,500 comp). Genie chips adapt to your
modules; widget chips include your top service + "Do you cover my area?".
**Test:** sign in as aatrala@gmail.com → Genie in the Grow section;
chips reflect enabled modules. Widget: open the demo chat → a chip
named after the top service.

### 39 — Preview buttons alignment + page polish ✅
Segmented Desktop/Phone switch, Refresh + Open in one aligned group,
phone bezel frame, responsive heights.
**Test:** app → Your page → Preview card → toggle Desktop/Phone; on a
narrow window the controls wrap without overlapping.

### 40 — Connect domain "not functioning" (test.bluebasketlabs.com) ✅
Root cause: your personal workspace was Free — the Presence-Pro gate
refused before anything ran. Your workspace now carries a Presence Pro
comp, and the card states the plan requirement BEFORE you type.
**Test:** as aatrala@gmail.com → Your page → Your own domain → enter
test.bluebasketlabs.com → add the two DNS records it shows at your DNS
provider → Check status until Live (cert usually issues in minutes).

### 41 — Multiple slugs per workspace ✅
Extra addresses that 301-redirect to the primary (3 total on Trade, 5 on
Genie, upsell on Free). Redirect-not-serve keeps Google's view of your
page on one URL.
**Test:** Your page → Your address → Extra addresses → add one → open
makerbay.app/p/<alias> → lands on your main address. Live proof:
/p/southside-plumbing → /p/makerbay-demo.

### 42 — Help centre feature not findable ✅
It was buried at the bottom of Assistant → Behavior. Now its own tab.
**Test:** as aatrala@gmail.com → Assistant → Help centre tab → enable
toggle, title, intro, link to your public help pages.

### 43 — URL scraping fails on JS-built sites (greenlightyourapp.com) ✅
Two fixes: a headless-Chromium render Lambda now runs pages whose HTML
comes back empty (after markdown-twin and framework-data rescues), and
error messages show the server's real reason instead of "could not be
read".
**Test:** Assistant → Knowledge → website discover on
greenlightyourapp.com → pick the /docs pages → they add with real
titles (first page takes ~10s while the browser cold-starts).

### 44 — Unreadable red-on-red button in the AI assistant ✅
The "Book a time" button inside the Services card inherited the answer-link
rule (brand-coloured text) on a brand-coloured background - invisible.
Fixed the specificity clash, and added a computed readable foreground:
every brand-filled button (header, send, cards, booking pages) now picks
white or near-black automatically from the brand colour's brightness, so
any accent a business chooses stays readable.
**Test:** demo page → Ask a question → "Services & prices" chip → the
"Book a time" button inside the card is white-on-red. (Hard-refresh if
your browser cached the old stylesheet.)

### 45 — Page styles, blocks, FAQ, sub-pages, theming ✅ (v1)
Approved ladder shipped (docs/spec-page-styles.md): three styles (Simple
free / Grow + Storefront on Trade), drag-to-reorder + show/hide blocks,
owner-written FAQ with FAQPage structured data, real sub-pages
(/p/slug/faq and yourdomain.com/faq - both verified live on the demo),
palette on Trade, five curated font pairs on Genie, version history
(newest 20, restore never loses anything). New "Style" tab under Your
page. Not in v1 (parked): per-service pages, gallery block, Genie-written
page copy.
**Test:** Your page → Style → pick Grow, add an FAQ → open your page →
"See all →" → /faq sub-page.

### 48b — Admin console overhaul ✅ (all approved items)
Shipped 2026-08-25: Overview dashboard (signups, paying subs, open
tickets, near-cap sweep, recent staff activity), health flags on the
workspace list, one omnibox (email jumps to workspace, / focuses),
row-click navigation, inline reason panels replacing every browser
prompt, sticky workspace header with suspend/add-note, onboarding
checklist, Stripe deep links, usage bars vs limits, audit filters +
readable detail, staff accent colour + styled badge.
**Test:** admin.makerbay.app → Overview is the home page; open a
workspace → header actions expand inline; Audit log → action filter.

### 49 — Customer service / feedback / tickets ✅ (V1+V2)
Shipped 2026-08-25: Support & feedback under the account menu — the
MakerBay assistant answers first (V2), tickets with full threads below
(V1: problem/question/idea, free capped at 3 open, paid = priority).
Staff answer from the console Tickets queue; replies land in the
customer dashboard and inbox. Verified live: ticket created on the demo
tenant (priority, listed), staff routes refuse unauthenticated calls.
**Caveats:** aatrala@gmail.com is verified (confirmed 2026-08-25), so
YOUR notification emails deliver. SES is still in sandbox, so emails to
other customers only deliver once SES production access is granted
(request pending under External waits).
**Test:** app → account menu → Support & feedback → send a ticket →
answer it in the console → see the reply appear in the app.

### 50 — Configurable request-form fields + notification tiers ✅
Shipped 2026-08-25 as recommended: "Leave your details" form now LIVE in
the chat widget (it previously had no surface at all); owner chooses
phone (optional/required/off), address, preferred time, and one custom
question - customising is Trade-gated server-side (402 with upgrade
message on Free); extras stored on the request and in notify emails.
Notifications: Trade = instant per lead; Free = daily 7am AEST digest
(new RequestsDigestFn, cron 21:00 UTC) with an upgrade line. Verified
live: config gating, extras persisted ("What suburb is the job in?" →
Marrickville on the demo).
**Test:** Requests → Settings → Form fields; then demo chat → "Leave
your details".

### 51 — Edit page / Style flow ✅ (quick wins + Variant A)
Shipped 2026-08-25: shared PreviewPane beside the editor on BOTH Edit
and Style tabs (sticky on wide screens), save bumps the cache-busting
nonce so changes show instantly, honest copy ("visitors see it within
about 5 minutes"), Open ↗ button, layout thumbnails on the style picker.
Deferred: draft-preview endpoint for unsaved changes (follow-up).
**Test:** Your page → Style → change anything → the preview beside it
updates on save.

### 52 — Missed-calls notify field unexplained ✅
Now reads "Email me about missed calls at" with a placeholder and a line
explaining: the caller gets the SMS, this address is for you. Live.

### 53 — Genie conversation cluttered + quick buttons ✅ (Variant A)
Shipped 2026-08-25: markdown-lite rendering (bold, bullets, paragraphs)
with the model prompted to use it, full-height conversation, compact
header with the intro collapsing after the first message, four standing
quick buttons (Brief me / Diary / Money / Block time) with the rest
behind +, bubbles capped at a readable width, and a "checked: bookings,
money" caption under each answer. Variant B (structured briefing cards
with row-level actions) queued as the follow-up.

### 69 — Bookings/Reviews on by default + switch-off ✅
Shipped 2026-08-25: new workspaces start with Assistant, Booking AND
Reviews on (server-side at creation); every existing active workspace
was backfilled the same way (yours included - Booking is in your menu
now, no click needed). The Modules card gained "Switch off": it only
hides the module from the menu - data, config and paid-plan limits all
survive, and enable/disable no longer stomps a pro plan's limits.
**Test:** Workspace → Modules → Switch off Reviews → it leaves the
menu → Turn on → it returns.

### 68 — No way to configure booking times (aatrala@gmail.com) ✅
Root cause: Booking was never switched on for your workspace, and since
onboarding only enables the assistant there was NO screen anywhere to
switch other modules on - the API existed, the button didn't. Shipped
2026-08-25: a **Modules card on the Workspace page** (Assistant /
Booking / Reviews with one-click Turn on; the free stuff is labelled as
always-included, Genie points to Billing).
**How to set up booking:** Workspace → Modules → Turn on Booking →
Booking appears in the menu → **Services** (add each service with
duration + price) → **Hours** (your weekly working hours) → Diary shows
bookings; then Your page → show booking so customers can book. Free
includes 20 bookings/month.

### 64 — Help centre empty / no authoring ✅ (day 1) / 💬 (native articles)
Diagnosis: your 19 sources were ALL ready but publishing lived only on
the Knowledge page, so the centre stayed empty. Shipped 2026-08-25: the
Help centre tab now has an Articles card - published list (with
generated title + category), "Ready to publish" list with one-click
Publish / Publish-all (and Unpublish / Unpublish-all), and a plain
callout when the centre is live but nothing is published.
**Test:** Assistant → Help centre → Articles card → Publish all →
open your help centre (index refreshes within ~1 minute).
**Proposal awaiting your agreement:** write articles natively in the
Help centre tab (a text editor creating a text source - it trains the
assistant automatically via the existing ingestion), edit them later,
and a "help article" badge on Knowledge. No new tier caps.

### 65 — Help centre presentation + bulk + counts ✅
Quick wins shipped 2026-08-25 (Unpublish/Unpublish-all, ~1-min index
refresh); everything else shipped the same day inside the 66 build:
article formatting, category reordering, popular strip, cap raise
(20/60/150) with a visible meter + crawl-truncation warning. **The
40+ vs 18 mystery:** your GreenLight crawl silently stopped at the old
20-source cap (19 stored, 18 published) - now visible and raised.
Still out of scope: images in articles (queued with native authoring).

### 66 — Help centre themes ✅ (v2 shipped after two-agent consult)
Approved 2026-08-25 and built the same day (docs/spec-help-themes.md).
Five themes on one renderer - Clean (free), Bold / Editorial / Ledger /
Signwriter (Trade), picked in the Help centre tab; Genie adds any
Google font, second accent, your logo, no MakerBay badge. Every tier
also gained: Popular strip (pin 4 on Trade), category counts and
reordering (Trade), related articles, "Was this helpful?", read time,
phone/email escalation block, Article + breadcrumb JSON-LD, and
model-formatted article bodies at publish ("Improve formatting"
upgrades existing articles without touching hand-edited titles).
Caps: 20 free / 60 Trade / 150 Genie with a visible "N of M sources"
meter and a crawl-truncation warning (the 40-vs-18 fix, issue 65).
**Test:** Assistant → Help centre → pick a theme → open your centre;
Articles → Improve formatting → open any article: headings, steps,
tips, related links, Was-this-helpful.

### 67 — Help "Ask a question" opens a separate page ✅
Shipped 2026-08-25: help centre pages now load the chat widget (your
brand colour), and every "Ask a question" button opens it in place. The
links keep their hrefs so crawlers and no-JS readers still work.
**Test:** open a help article → Ask a question → chat opens as an
overlay on the same page.

### 60 — Page edit improvements ✅ (fixes) / 💬 (merge proposal)
Shipped 2026-08-25: scan-to-book QR toggle on the page (off by default;
server-rendered, points at booking when it exists - verified live on the
demo); editor now uses the full desktop width (the 980px shell cap made
it read like two phones); business name editable in the Words card (it
is the page's big title - the "Aatral Arasu" confusion); checklist leads
with a progress bar + the single next step, full list behind a
disclosure. Merge approved and shipped (see 60b). Follow-up shipped
2026-08-25: the preview now renders UNSAVED edits as you type (debounced
draft preview, labelled "unsaved changes", back to live on save).
**Test:** Page → type in the headline → preview updates in under a
second without saving.

### 53B — Genie briefing cards ✅
Shipped 2026-08-25: diary and unpaid-invoice answers carry compact cards
with real ids; Done / Cancel / Chase buttons propose deterministically
(no model call) into the same confirmation-card flow. Verified live:
card button → accurate proposal → decline.

### 61 — Quote notifications placeholder ✅ / invoice design 💬
Placeholder + explainer shipped. Approved batch shipped 2026-08-25:
ABN/licence footer line on public quotes + invoices (Quotes → Settings,
200 chars), your page photo as the document logo (toggleable), and the
pipeline value strip on the quotes list (awaiting answer / accepted to
invoice, in dollars).
**Test:** Quotes → Settings → set a footer line → open a public quote
link: footer under the totals, logo in the header.

### 62 — Duplicate phone question in request settings ✅
The old "ask for a phone number" checkbox duplicated the new Form fields
Phone selector - removed; the selector is the single control.

### 60b/61b — Approved builds shipped ✅
2026-08-25: Edit+Style merged into one Page screen (Content / Appearance
/ Publish sections with a sticky jump rail beside the live preview; old
Style links redirect). Quotes/invoices: overdue aging chips, invoice
tabs + outstanding total, Create-invoice in the accepted-quote header,
empty-state links, and documents in the owner's colours (public bold
band + a ThemePreview showing YOUR name, accent and top price lines).
The deferred trio (ABN/licence footer, pipeline value strip, document
logo) shipped 2026-08-25 - see 61. Genie checkout is now a single line
(the usage line attaches automatically after subscribe).

### 63 — Stripe Connect onboarding ⛔ awaiting Stripe's review
Progress to date: Accounts Write scope enabled (verified working), the
one-time **Connect platform profile** questionnaire submitted by you
2026-08-25. The last blocker is on Stripe's side: account creation
returns "review the responsibilities of managing losses" until their
review of the profile completes (retested live - still pending). Ping
me when Stripe's approval email lands; I then retest onboarding and
run the already-approved full Connect + live payment e2e. Meanwhile
the Get Paid page shows an honest message instead of a mystery 500.

### 56 — Genie checkout shows "Genie and 1 more" (Trade) ✅
Cause: the Genie subscription reused the Trade product's usage-metered
assistant-messages price, so Stripe named both products. Fixed: the
Genie product now carries its own metered price on the same meter and
allowance (created automatically at next checkout; no Stripe dashboard
action needed). Existing behaviour and billing unchanged - only the
label. **Test:** Billing → Genie upgrade → checkout should read
"Subscribe to MakerBay Genie" with two lines, both under Genie.

### 57 — Pricing page UI + homepage missing Genie ✅
Homepage now shows all three plans (Genie card added, heading "Three
plans. No homework."); pricing page sells Genie as live with the correct
2,500-message allowance, the confirm-card story, and priority support
(now real - the ticket queue honours it); "when Genie ships" copy
retensed; Genie moved out of the roadmap's Next column and its module
status is live.

### 58 — Marketing site: footer presentation + stale content ✅
The one hand-written module page (Assistant) carried an old single-line
footer - now the standard columned footer everywhere. Stale content
swept with 57: Genie tense, allowances, roadmap. Remaining hand-written
copy on the Assistant page reads fine.

### 59 — GitHub source + tracker upkeep ✅
All work through issue 58 committed and pushed; repo has no stray files
(site/dist and build outputs are gitignored); this tracker now updates
in the same commit as every issue.

### 55 — Billing page never returns from Stripe ✅
Root cause was in the browser, not the flow: checkout and portal both
return live Stripe URLs in about a second (your new key scopes are
working - verified live). But pressing Back from Stripe restored the
page from the back/forward cache frozen at "Opening Stripe…" with the
buttons disabled. Fixed: a bfcache restore now resets the button and
refreshes the billing summary.
**Test:** Billing → any Stripe button → press Back on the Stripe page →
the billing page is usable and refreshed.

### 54 — Admin sidebar + account dropdown ✅
Shipped 2026-08-25: the staff console's bottom block is now the same
account dropdown pattern as the customer app - avatar button opening
quick links (customer app, changelog), sign out and the platform
version.

### 48 — Admin OTP without a connected authenticator app ✅
Nothing needs connecting beforehand - the first sign-in IS the setup:
after the temp password → new password steps, the console shows the TOTP
enrolment screen. Install any authenticator app first (Google/Microsoft
Authenticator, Authy, Bitwarden, 1Password), then scan. Shipped: that
screen now renders a scannable QR code (the raw secret stays as the
no-camera fallback) and says plainly that no prior setup is needed.

### 46 — Admin portal login + pending admin spec ✅
Login: your staff account existed but the temp password was lost - a
fresh one is in your inbox (from Cognito). Sign in at admin.makerbay.app
→ set a real password → scan the TOTP QR. Admin P1 shipped the same day:
SES suppression lookup/removal (Email page), read-only conversation
viewer (workspace page, audited), staff audit log page, and scripted
privacy export/delete (scripts/privacy-export.mjs / privacy-delete.mjs).
Also fixed: the tenant 360's page/source fields were silently blank
(missing env). **Test:** sign in → Workspaces → open one → "Load recent
conversations"; Email → suppression check; Audit log nav item.

### 47 — Captcha / spam protection for booking + assistant ✅ (phase 1) / 🔶 owner hold (phase 2)
**Analysis (2026-08-25):**
- Exposure: the public POST endpoints (assistant chat, booking create,
  request submit, review submit) can be scripted; the cost risk is
  Bedrock invocations (chat/Genie) and SES sends, not data.
- Existing damping already in place: per-tenant monthly message caps,
  booking caps, and the $80 AWS budget alert. So the real gap is BURST
  abuse inside a month.
- Options considered: **AWS WAF** cannot attach to our HTTP API (v2) -
  it would need a CloudFront front on api.makerbay.app (~$10-15/mo +
  architecture change). **Cloudflare Turnstile** is the best invisible
  captcha widget but adds a vendor and does not stop raw API calls.
  **API Gateway stage throttling** is free, invisible, and caps any
  burst platform-wide.
**Decision (founder, 2026-08-25):** invisible + cheap now; alert email;
implement heavier tools only when surprises actually appear.
**Shipped (phase 1):** stage throttling 50 req/s (burst 100) on the API,
SNS topic `makerbay-abuse-alerts` emailing aatrala@gmail.com, and two
CloudWatch tripwires: Bedrock invocations >2,000/hour and API requests
>50,000/hour. **Confirm the SNS subscription email when it arrives or
alerts will not deliver.**
**OWNER HOLD (phase 2, do not build until an alarm fires):** CloudFront
front on the API + WAF Challenge/CAPTCHA, or Turnstile on the booking
form. The alarm email is the trigger to revisit.

## Approved queue (on me)

1. **Voice latency probe** — ⛔ 30-min founder console task, then calls.
   Architecture settled: Amazon Connect shipped NATIVE Nova Sonic
   agentic self-service (Nov 2025, us-east-1) - no custom bridge needed;
   the probe measures the real production stack. Standing: instance
   `makerbay-voice-probe` ACTIVE + DID **+1 (414) 219-1295**. Blocked
   on: the AI-agent configuration lives in Connect's console-only "AI
   agent designer" - docs/probe-voice-latency.md has the exact ~30-min
   steps, the 10-call test script, and my measurement plan against the
   <1,200ms median / <900ms p95 gate.

## Awaiting your decision 💬

- **Native help-article authoring** (64 proposal A) — write and edit
  articles directly in the Help centre tab; each is a text source, so
  it trains the assistant automatically; "help article" badge on
  Knowledge. Images in articles ride along. Say go and I build.
- **WhatsApp surface for Genie** — text your Genie on WhatsApp instead
  of opening the app; same briefings + confirmation cards. Costs: WABA
  number, Meta verification, per-conversation fees. Parked until you say go.
- **Quotes/invoice extras** (from 61 consult) — remaining ranked
  dashboard ideas beyond what shipped; pick during testing if wanted.

## Blocked on you (quick) ⛔

- **SNS abuse-alert confirmation** — the subscription email to
  aatrala@gmail.com is still PendingConfirmation; until you click it,
  the cost-tripwire alarms (issue 47) cannot email you.
- **Voice probe console setup** — ~30 min in the Amazon Connect console
  (docs/probe-voice-latency.md) + 10 test calls to +1 (414) 219-1295;
  then I run the latency measurement against the go/no-go gate.
- **Disk space** — your C: drive hit 100% full on 2026-08-25 (broke
  three deploys). I freed ~12GB from the npm cache; please clear more
  when you can.

## External waits

- **Stripe Connect platform-profile review** (issue 63) — you submitted
  the questionnaire; account creation stays blocked until Stripe
  approves. Ping me when the email lands and I retest + run the full
  Connect onboarding and live payment e2e (already approved). Key
  scopes are DONE - Accounts Write confirmed working.
- SES production access. SMS origination identity registration.
- ~~Chime SDK Voice enablement~~ — no longer needed: the probe now uses
  Amazon Connect's native Nova Sonic agentic self-service.

## On hold (deliberate)

- Marketplace (~1000 customers). Booking deposits. Ops hygiene (root →
  IAM Identity Center — would also stop the AWS session expiring
  mid-deploy — alarms, CI, Cost Explorer check).

## Standing facts

- Releases: CHANGELOG.md (2.23.1). Platform 1.33.0.
- Founder workspace (aatralarasu) comps: Presence Pro + Genie 2500,
  seeded via scripts/seed-founder-grants.mjs.
- Demo workspace (makerbay-demo / Southside Plumbing): docPrefix SP,
  custom domain demo.makerbay.app, slug alias southside-plumbing,
  deposit 20%, Genie grant.
- Support runbook: docs/runbook-support.md (staff bootstrap is CLI-only).
