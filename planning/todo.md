# MakerBay — Issue Tracker & Status Board

Location: `makerbay-app/planning/todo.md` (inside the app repo).
Updated 2026-08-25. One section per issue with a manual test you can run.
Issues 1-25 predate this tracker (earlier sessions); the numbered log
below starts where the current stream picks up.

Legend: ✅ live and verified · 🔶 live, founder test welcome · ⏳ in
progress · 💬 awaiting your decision · ⛔ blocked

## Issue log

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

## Approved queue (on me)

1. **Voice latency probe** — Stage 1 of spec-voice-live-agent.md (~1
   week, <$100): Connect instance + DID + Nova 2 Sonic handler, real
   recorded calls against the <1,200ms median gate. Next dedicated
   session; you step in on AWS support blockers.

## Awaiting your decision 💬

- **WhatsApp surface for Genie** — text your Genie on WhatsApp instead
  of opening the app; same briefings + confirmation cards. Costs: WABA
  number, Meta verification, per-conversation fees. Parked until you say go.
- **Admin console P1** — SES suppression viewer, read-only conversation
  viewer, scripted privacy export/delete, audit log reader (~4-5 days).
  Recommended before ~100 customers; pick any subset.

## Blocked on you (quick) ⛔

- **Stripe restricted key scopes** — add write scopes: Accounts, Account
  Links, Checkout Sessions, Payment Intents, Refunds, **Products, Prices,
  Subscriptions** (Genie plan product is created via API on first
  checkout). Add `checkout.session.completed` + `account.updated` to the
  webhook. Then I verify Connect onboarding + live payment + Genie
  checkout end to end.
- **Disk space** — your C: drive hit 100% full on 2026-08-25 (broke three
  deploys). I freed ~12GB from the npm cache; please clear more when you
  can.

## External waits

- Chime SDK Voice enablement (AWS support case) — gates voice go-live.
- SES production access. SMS origination identity registration.

## On hold (deliberate)

- Marketplace (~1000 customers). Booking deposits. Ops hygiene (root →
  IAM Identity Center — would also stop the AWS session expiring
  mid-deploy — alarms, CI, Cost Explorer check).

## Standing facts

- Releases: CHANGELOG.md (2.14.0). Platform 1.24.0.
- Founder workspace (aatralarasu) comps: Presence Pro + Genie 2500,
  seeded via scripts/seed-founder-grants.mjs.
- Demo workspace (makerbay-demo / Southside Plumbing): docPrefix SP,
  custom domain demo.makerbay.app, slug alias southside-plumbing,
  deposit 20%, Genie grant.
- Support runbook: docs/runbook-support.md (staff bootstrap is CLI-only).
