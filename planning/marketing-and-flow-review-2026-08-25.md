# MakerBay — marketing pages, app flows, competitors & gaps

**Date:** 2026-08-25 · **Prepared for:** founder decision
**Evidence base:** this repo (site/, web/, modules/*/module.json, docs/), live
makerbay.app + app.makerbay.app pages fetched and walked, current competitor
pricing/pages researched from vendor pages and 2026 reviews. Interactive
browser signup was not completed in this pass (browser-control approvals
expired) — flows below are verified from the actual code and live pages, and
a hands-on session is queued at the end.

---

## 1. Competitor analysis

### 1.1 The field

| Competitor | What it is | Entry price (2026) | Free? | Core loop |
|---|---|---|---|---|
| **Jobber** | FSM for home services | Core $39/mo ($29 annual), 1 user; +$29/extra user | 14-day trial only | Quote → schedule → invoice → payment; client hub |
| **Housecall Pro** | FSM, payments-led | Basic $79/mo ($59 annual); usable tier ~$189 | 14-day trial only | Same loop + marketing automation, Instapay |
| **ServiceM8** | FSM for solo/micro teams | ~$29/mo, per-user add-ons | Free tier (very limited) | Job cards, mobile-first dispatch |
| **ServiceTitan** | Enterprise FSM | ~$24k+/yr, sales-call only | No | Everything, at enterprise complexity |
| **Calendly** | Meeting scheduling | $10/seat/mo | Yes (1 event type) | Booking links, team routing |
| **Acuity (Squarespace)** | Appointment system | $16–20/mo | 7-day trial only | Booking + intake forms + payments + packages |
| **Square Appointments** | Booking inside Square POS | Free (1 staff) → $29 | Yes | Booking tied to POS, card-on-file no-show protection |
| **Fresha / Vagaro** | Salon verticals | $20/mo + commissions/add-ons | "Free" ended | Booking + marketplace + payments |
| **NiceJob** | Review automation | $75/mo flat, no contract | 14-day trial | Job-complete → review request |
| **Podium** | Comms + reviews | $459+/mo, 12-month term | No | Text inbox, webchat, reviews, payments |
| **Smith.ai / Broadly / Jobber AI Receptionist** | AI/human answering | $99–200/mo add-on | No | Answer calls, book, qualify |
| **Thryv / GoHighLevel** | All-in-one SMB / agency | $228+/mo; GHL $97–497/mo | No | Everything bundled, heavy setup |

### 1.2 What their marketing pages do (patterns to steal or reject)

**Jobber homepage:** outcome headline ("Run a stronger service business") →
app-store ratings (4.8 / 13,861 reviews) immediately under the hero → a wall
of real customer photos with names and business names → feature sections →
pricing CTA. *Pattern: proof before product.*

**Housecall Pro homepage:** "Everything to run and grow your business" →
email capture in the hero → four pillars (Grow revenue / Manage jobs / Get
paid / Run your business) → "Meet your AI Team" section → trade picker
(HVAC, Plumbing, Electrical, Contractor, Handyman, Cleaning) → testimonials
with growth numbers ("50% growth every year", footnoted) → community/resources.
*Pattern: segment by trade, sell the AI crew, footnote the claims.*

**Calendly:** the product *is* the page — you see a booking flow in the first
screen. *Pattern: show the artifact, not the adjective.*

**NiceJob:** one number, one promise, $75 flat, "no contracts" on the card.
*Pattern: price honesty as the headline.*

**Podium (reject these):** CAD prices rendered to US visitors, "contact sales"
carve-outs per trade, 12-month auto-renew with a 30-day annual exit window.
This is the #1 resentment cluster in every review corpus, and MakerBay's
"month to month, no card to start, cancel any time" is the direct counter.

### 1.3 Their pros and cons, compressed

| | Pros worth matching | Cons worth attacking |
|---|---|---|
| Jobber | Polished client hub; transparent published pricing; mobile app 4.8★ | No free plan; AI receptionist is a $99 add-on; per-seat creep; tier jumps ($119→$169 for one helper) |
| Housecall Pro | Instapay same-day payouts; marketing automation; trade-specific pages | Basic tier is deliberately useless (no QuickBooks, no GPS); add-on stacking (Price Book $149/mo!); Android app 3.3★; support moved to AI |
| ServiceM8 | Simple, cheap entry, iOS app techs love | Add-ons stack; thin reporting; AU-centric |
| Calendly | 2-minute setup; free tier works | Per-seat; white-label impossible ("sticks out like a sore thumb"); read-only API; billing-after-pause complaints |
| Acuity | Intake forms, packages, deposits, per-calendar (not per-seat) pricing | No free plan; setup complexity; brand removal only on top tier |
| Square Appointments | Genuinely free for 1 staff; card-on-file kills no-shows | Only valuable inside Square POS |
| NiceJob | Flat price, no contract, does one thing well | Reviews only; no inbox; price scales with customer count quietly |
| Podium | The shared text inbox is genuinely loved | 12-month traps, collections threats, "cancel only after a meeting", can't export your own data |
| Smith.ai/Broadly AI | Real missed-call revenue rescue | $99–200/mo; detectably robotic; wrong-booking risk lands on the owner |

### 1.4 The three universal complaint clusters (confirmed across G2/Capterra/Trustpilot/Reddit, matches docs/market-research.md)

1. **Opaque or trap billing** — fine-print contact definitions, unnotified plan
   doublings, per-resolution AI pricing fear, commissions on the business's own
   customers.
2. **Contract and cancellation friction** — auto-renew traps, "cancel by email
   30 days before the annual window", phantom cancellations.
3. **Unreachable support** — weeks-long waits, submit-into-the-void.

Plus two 2026 additions: **incumbent AI is now a complaint source** (Fin
"overhyped", Lyro "can barely answer", robotic voice agents) and **data
portability** ("YOU CANNOT EXPORT YOUR OWN DATA").

**MakerBay's positioning is already aimed at all five** (grounded+cited answers,
no review gating, CSV export, month-to-month, honest caps). The marketing just
doesn't say it loudly enough yet — see §3.

---

## 2. Marketing page variations — pick a direction

The current homepage is structurally good (journey: Found → Answered → Booked →
Priced & paid → Reviewed). These are four directions; they are *combinable*,
but each leads with a different bet.

### Variant A — "The missed call is the pitch" (pain-led)

- **Hero:** "You lose the job before you know it existed." Sub: the customer
  called, you were under a sink, they booked someone else in 4 minutes.
  MakerBay answers, books and quotes while your hands are full.
- **Structure:** Pain → money math (jobs lost × average job value, an honest
  calculator with *their* numbers) → the rescue loop (call → text → booking
  link → diary) → then the full journey → pricing.
- **Why:** every competitor research pass shows missed calls are the loudest
  pain; nobody owns the honest version of this message (the "$7B lost" stats
  are fabricated — you can *say that*).
- **Risk:** missed-call rescue is still gated on carrier access. Leading with a
  not-yet-live feature repeats the industry's overpromise sin. Only run this
  when rescue ships, or lead with the assistant/widget version of the same
  pain.

### Variant B — "The page that works while you don't" (product-led, current direction, sharpened)

- **Hero stays close to today**, but the SVG chat mock becomes a **real,
  interactive demo above the fold**: the live demo page embedded or a 20-second
  looped video of ask → answer → book → review. Calendly's rule: show the
  artifact, not the adjective.
- **Structure:** Hero + live demo → journey (keep) → "see it for real" moves
  *up* → personas → pricing → trust.
- **Why:** Presence is the product per the vision doc; the demo page is your
  single best asset and it is currently one screenshot and a link halfway down.
- **Risk:** low. This is the safe increment.

### Variant C — "Proof-led" (Jobber's play, honest version)

- **Hero:** outcome + the strongest verifiable proof you have. Today that's not
  customers — it's your *checkable claims*: the public changelog, the public
  roadmap with what you won't build, the no-gating pledge, CSV export. "Built
  to be checked, not believed" moves from section 6 to the hero.
- Later, swap in real testimonials, real numbers ("12 bookings while he was on
  a roof"), app badges if a PWA ships.
- **Why:** in a market where headline stats are fabricated (you documented
  this), radical checkability *is* the differentiator, and it's free.
- **Risk:** proof-without-customers can read as philosophy. Works best combined
  with B's live demo.

### Variant D — "Vertical landing pages" (structural, not a homepage)

- makerbay.app/for/plumbers, /for/salons, /for/cleaners, /for/tutors — each
  with that trade's pain first (roof cavity vs. chair interruption vs. day job),
  that trade's demo workspace, that trade's vocabulary.
- Housecall Pro's trade picker and the "package vertically, build horizontally"
  finding both point here; your personas section is the seed.
- **Why now-ish:** cheap to generate from module manifests (your own rule:
  don't describe anything twice — add a `verticals` block to the manifest and
  generate). **Hold until** the homepage converts, so you learn on one page
  before cloning it.

**Recommendation: B now, C's trust content pulled into the hero, A when rescue
ships, D after conversion data exists.**

### Homepage copy issues to fix regardless of variant

1. **Hero CTA asymmetry:** "Start free" and "See a live example page" compete.
   The demo is the stronger proof — try making the demo the primary CTA and
   "start free" the quiet one, measure both.
2. **"Live in about ten minutes"** appears twice (hero small print + a full
   section). Say it once, prove it once.
3. **The modules grid** ("One account, more modules over time") describes
   *architecture* to a buyer who doesn't buy architecture. The journey section
   already covers it better — consider cutting the grid to a single line with a
   roadmap link.
4. **No social proof anywhere.** Until you have customers, borrow credibility
   honestly: the changelog count ("120 changes shipped, all public"), the
   roadmap's won't-build list, response-time commitments.
5. **No comparison capture.** "Jobber alternative", "Fresha without the 20%"
   searches are live churn intent and you have no page for them. One honest
   /compare/jobber page (their price + add-ons vs your $29 flat) is the
   highest-ROI page you don't have.

---

## 3. Pricing structure — assessment

Current: **Free $0 / Trade $29 / Genie $99**, USD worldwide, month-to-month
headline, $290 annual (2 months free), message overage opt-in at $0.02,
polite-stop default.

**Verdict: the structure is right; the presentation has cracks.**

What's right:
- $29 lands exactly on Jobber's entry while including AI, reviews and a
  customer page Jobber doesn't have. That comparison belongs *on the pricing
  page*, named.
- Free-forever (not a trial clock) beats every direct competitor — only Square
  Appointments and Calendly's crippled tier are free, and neither runs a
  business page + quotes + invoices.
- Honest framing of the 20/mo free booking cap as a value line ("if we're
  taking 20+ bookings a month, $29 is fair") is *excellent* — keep it verbatim.
- Opt-in overage with polite-stop default directly answers the #1 complaint
  cluster.

Cracks:
1. **Genie row contradicts itself.** On /pricing the module table says
   "Genie — **In Trade** — Available now", but the tier cards make Genie the
   $99 product with a 250-message "taster" in Trade. A buyer cannot tell what
   $29 includes. Fix the table to "Taster in Free/Trade · Full in Genie".
2. **No competitor anchor.** "For what Jobber charges to start" is in the pitch
   line — good — but there is no table making the comparison concrete
   ($29 flat vs $39 + $99 AI add-on + $29/seat). Concrete beats clever here.
3. **Currency.** USD-worldwide for an AU-flavoured product ("tradie", "smoko",
   .com.au in copy) is a small trust leak. The pricing proposal already flags
   the AUD/INR geo decision — decide it; don't leave the mixed signals.
4. **No annual-first option test.** Competitors discount annual 40%; you offer
   17%. That's a deliberate trust choice (month-to-month headline) — keep it,
   but consider "annual = 2 months free + we pause at your cap" as a line on
   the Trade card, not just fine print.
5. **No founding-member mechanic.** Pre-revenue, a "first 100 workspaces:
   Trade $19 for as long as you stay" does acquisition and testimonials at
   once, and costs less than ads.

---

## 4. Application flows — what to improve

Verified from code (web/src, modules/*/web) and live pages.

### 4.1 Signup & login (web/src/pages/Login.tsx)

Current: email + password → verification code → login. Clean, minimal.
Gaps vs. expectation:
- **No "forgot password" link.** This is a hard gap — Cognito supports it;
  the UI simply doesn't expose it.
- **No Google sign-in.** Your buyer has a Google Business Profile and a Gmail;
  every competitor offers one-tap Google. It also pre-seeds name/email.
- The tagline under the logo ("Modular business tools for SMBs") is the old
  positioning. The site says "be found, answered and booked without lifting a
  finger". The login screen is a marketing surface — align it.

### 4.2 Onboarding (Onboarding.tsx → Knowledge)

Current: one field (business name) → straight to Knowledge with website
import. This is *very good* — better than Jobber/HCP's data-entry marathons.
Improvements:
1. **Ask one more question: "What do you do?"** (trade picker). It unlocks
   pre-seeded FAQ/price-list/service templates per trade, and later the
   vertical analytics. One dropdown, skippable.
2. **The website import is the magic moment** — a brand-new workspace should
   *show the scrape happening* and then "your assistant already knows your
   prices — ask it something", pushing into Playground with a suggested
   question. Today it lands on a form.
3. **Presence readiness meter** from minute one: "Your page is 40% ready — add
   hours, one photo, one priced service" ties onboarding to the page-goes-live
   checklist that already exists in Presence.

### 4.3 Shell & navigation (Shell.tsx)

The Work/Grow grouping and the mobile bottom-nav (Requests badge, Diary,
Quotes) are genuinely better thought-out than competitors' hamburger dumps.
Gaps:
- **No home screen.** Landing routes to the first module, not to a
  "what needs you today" surface: waiting requests, today's bookings, unpaid
  quotes, new reviews. Genie's briefing is this surface — consider making a
  lightweight version of it the default landing for everyone (it's also the
  Genie upsell, seen daily).
- **The Genie entry point** sits in "Grow", but its job is daily ops. If it
  stays a paid teaser, put it top of Work.
- Desktop sidebar has no collapse-to-icons; low priority.

### 4.4 Module-level flows

- **Bookings:** solid v1 (real slots, buffers, self-cancel, reminders). The
  two missing pieces are the two customers will ask about first: **Google
  Calendar two-way sync** and **deposits/card-on-file** (Square's no-show
  protection is why salons stay). Both are known-deferred — they're now the
  top two product gaps, see §5.
- **Quotes → invoice:** a real strength; competitors charge for this loop.
  Surface it harder in the dashboard (a "quotes waiting > 3 days" nudge).
- **Reviews:** trigger-off-completion is exactly NiceJob's $75 loop, included
  in your $29. Say so.
- **Assistant:** grounded-with-citations and "says when it doesn't know" is the
  counter-position to Fin/Lyro complaints. The "questions it couldn't answer →
  answer once" loop (Requests) is the retention engine — it deserves a
  first-run empty state that teaches it, not just an inbox.
- **Get paid:** Stripe Connect shipped with 0% platform fee. Competitors take
  2.6–3.5% *plus* Instapay's 1%. "We add no fee — Stripe's rate is Stripe's"
  should be on the marketing site; today it's only on /pricing.

---

## 5. Product gaps — the honest list

Ordered by expected impact on the "found, answered, booked" promise.

| # | Gap | Why it matters | Status |
|---|---|---|---|
| 1 | **Missed-call rescue not live** (carrier/Chime gate) | It is half the homepage's "answered" promise and the loudest pain in the market. Until it ships, the hero slightly overpromises | ⛔ blocked on telephony enablement |
| 2 | **No Google Calendar / two-way sync** | Top booking-tool expectation; without it the diary competes with the calendar the tradie actually checks | Deliberately deferred (manifest FAQ) — needs a date |
| 3 | **No deposits or card-on-file at booking** | No-show protection is *the* reason salons pay Fresha/Square; also unlocks paid-before-created bookings | Deferred until payments chain supports it |
| 4 | **No native mobile app / push notifications** | The whole thesis is "holding a tool, not a phone" — yet owner alerts (new request, new booking) ride email. A PWA with push covers 80% | Not in roadmap Now/Next |
| 5 | **No password reset on the login screen** | Basic auth hygiene; will cost support tickets | Small fix, code-confirmed missing |
| 6 | **No Google sign-in** | Friction at the exact moment of highest intent; also the GBP-integration account | Not built |
| 7 | **No QuickBooks/Xero integration** | Named in research as the integration gap; double-entry is why owners leave booking tools | Deliberate ("integrate, don't build") but not built |
| 8 | **No intake forms / custom booking fields** | Acuity's core strength for clinics/salons; "what should I know before the job" is universal | Not present |
| 9 | **No packages / recurring appointments / subscriptions** | Salons, cleaners, maintenance contracts — recurring revenue businesses can't model themselves | Not present |
| 10 | **No two-way SMS/WhatsApp channel** | Research's strongest adjacent signal; customers live on WhatsApp in target markets (IN/LatAm) | Messaging-as-channels was the plan; deferred |
| 11 | **No multi-staff calendars / round-robin** | Caps you at solo operators; fine *for now* but excludes 5-person salons | Deliberate scope |
| 12 | **No competitor-import onboarding** | "Import your contacts/reviews from X" is a proven wedge and your export pledge makes the promise symmetric | Export ✅, import not visible |
| 13 | **No social proof / comparison / vertical pages on the site** | The SERP for "jobber alternative" is all affiliates; an honest entrant can rank | Marketing gap, not product |
| 14 | **Genie pricing-table contradiction** | "In Trade" vs $99 tier confuses the exact page where confusion kills | Content bug, fix this week |
| 15 | **Login/app tagline still says "modular business tools for SMBs"** | The app contradicts the site's positioning at the door | Content bug |

---

## 6. Quick wins (this week, no architecture)

1. Fix the /pricing Genie row + homepage FAQ pricing sentence.
2. Add "forgot password" to Login.tsx.
3. Update the app login tagline to the site positioning.
4. Move the live demo to the homepage hero (Variant B increment).
5. Add "We add no fee on card payments" to the homepage trust section.
6. Add one honest /compare page vs. Jobber pricing mechanics.
7. Onboarding: trade picker dropdown + first-run Playground suggestion.

## 7. Queued: hands-on browser test

Interactive signup + click-through of app.makerbay.app via the browser bridge
was attempted but the approvals expired this session. When you're at the
machine, say the word (and approve the browser commands, or paste a test
account) and I'll run the full flow: signup → workspace creation → knowledge
import → assistant playground → booking → quote → invoice → review → page
publish → billing screens, with screenshots, at desktop and phone widths.
