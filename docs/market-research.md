# Module market research — findings log

Working log of market evidence behind the module roadmap. Full narrative
report (evidence tables, signal matrix): the "The Next Module" artifact —
https://claude.ai/code/artifact/94eb952a-31bf-4fe9-bf7e-ac9fc3daeb3c
Tooling used to gather this: [research-tooling.md](research-tooling.md).

## Pass 1 — four-platform sweep (2026-08-23)

Sources: Product Hunt launches 2021-2026, G2 (via search snippets;
direct fetch blocked), Capterra/GetApp shortlists (fetched directly),
Reddit (via search-rendered text; crawling blocked).

### Roadmap conclusion

| Order | Module | Verdict | Core evidence |
|---|---|---|---|
| Module 2 | Booking/scheduling | **Build next** | Strong on all 4 platforms. Biggest adjacent SMB category (Acuity ~5.8k, Calendly ~4.1k Capterra reviews). Complaint clusters: per-seat creep (Calendly), add-on stacking (Vagaro $24→$50-60), commissions (Fresha 20%). Free Calendly clone hit #2 on PH in Jan 2026 — pricing resentment unresolved. Unique combo: assistant that books. |
| Module 3 | Messaging (WhatsApp/SMS) | **Build as channels** | Strongest PH signal (Superchat ~1,440 votes #1/day; Tanka #4 of 2025). Shape: deliver the tenant's trained assistant on WhatsApp/SMS + unified inbox + missed-call text-back. NOT a standalone bot builder. Caveat: 10DLC/WhatsApp BSP lead time. |
| Module 4 | Reviews/reputation | **Added to SPEC §5** | Was not in original candidates. $49-449/mo incumbent umbrella; Podium Trustpilot 1.5 + D- BBB (contract traps); NiceJob proves $75/mo simple product wins; 54% of Capterra category reviewers call review-request the critical feature. Composes: booking completion → review request via messaging. |
| Later | AI receptionist (voice) | **Post-M4 bet** | 8-10 PH launches in 18 months, no SMB-layer winner. Missed calls = loudest Reddit pain. Trust engineering (accents, handoff, mid-call errors) is the product. Module 3's missed-call text-back captures much value earlier. |
| — | Dashboards | **Reframe as platform feature** | Weak on all 4 platforms as a product (Geckoboard 48 G2 reviews). But "limited reporting" recurs inside booking/chat tools → free cross-module Insights (spec M4 screen is right shape). |
| — | Compliance | **Cut** | Wrong buyer: Vanta/Drata "SMB" = venture B2B startups at $7K-60K/yr, ~100x MakerBay ARPU. |

Also triaged: forms (free sub-feature; price anchored at $0 by Google
Forms/Tally), knowledge base (publish tenant RAG corpus as hosted help
center — cheap Module 1 extension), invoicing (integrate QuickBooks, don't
build), CRM (lightweight contact timeline only).

### Cross-cutting strategy findings

1. **The wedge is pricing mechanics, not features:** flat monthly, no
   per-seat/commissions/add-on stacking, month-to-month, self-serve cancel,
   white-label included (Chatbase charges ~$1,188/yr to remove branding),
   usage alerts + graceful degradation (spec's "201st message politely
   refuses" is right).
2. **Subscription fatigue validates the platform thesis** (Reddit: 15-20
   tools, "$50k/yr on software that doesn't talk to each other without
   Zapier"). Native inter-module data flow is the pitch.
3. **Package vertically, build horizontally:** verticals dominate Capterra
   scheduling (Vagaro, Fresha, GlossGenius, Jane) but decay on monetization
   creep. Sell "MakerBay for Salons/Clinics/Trades" as flat-priced module
   bundles — templates, not codebases.
4. **Agency/white-label channel is plausible** (GoHighLevel $497/mo SaaS-mode
   motion); MakerBay is already API-first + multi-tenant. Vendor-sourced
   evidence — validate before building.
5. **Module 1 implications:** assistant must act (lead capture, later
   booking); citations are a marketable anti-hallucination feature; "easy AND
   controllable" is unowned; G2 review program is cheap white space (Chatbase
   ~14-19 G2 reviews at ~$8M reported ARR).

### Known gaps flagged by pass 1

Vertical subreddits (r/salons, r/Contractors, r/therapists), r/agency +
r/msp reseller threads, demand-side review-management threads, per-product
complaint depth in live chat/SMS, disputed figures (Acuity + Podium current
G2 ratings).

## Pass 2 — Bright Data + Apify deep-dive (2026-08-23, complete)

Primary-source pass over the gaps pass 1 flagged: G2 pages scraped directly
(Bright Data unlock), structured Capterra + Trustpilot reviews (Apify actors,
~180 reviews, ~$0.15 total), Reddit via SERP snippets with real permalinks
(full thread scraping blocked pending Bright Data KYC — see tooling notes).

### Confirmed ratings (settles pass-1 disputes)

| Product | G2 | Capterra | Trustpilot | Note |
|---|---|---|---|---|
| Podium | 4.5 / 2,110 | 4.3 / 526 | ~4.0 / ~274 | Cons tags: Expensive (70), Poor Support (63) |
| Acuity | 4.6 / 410 | 4.8 / 5,756 | — | 90% of G2 reviewers small-business |
| Calendly | 4.7 / 2,647 | 4.7 / 4,139 | 4.0 / 639 | Trustpilot 1-stars: post-pause billing |
| Tidio | 4.6 / 1,961 | 4.7 / 590 | 3.8 / 224 | Widest platform skew of any product |
| NiceJob | 4.8 / 419 | — | — | Zero 1-stars; markets "no contracts, $75/mo flat" |
| Intercom/Fin | 4.5 / 3,904 | — | — | Cons tags: Missing Features (135), AI Limitations (117) |
| ManyChat | 4.5 / 165 | — | — | "Active contact" billing-trap complaints |
| Fresha | — | 4.8 / 1,447 | 4.8 / 6,752 | Trustpilot score manufactured via solicited support reviews |

### The three universal complaint clusters

Every incumbent's critical reviews repeat the same three themes:

1. **Opaque / usage-trap billing** — ManyChat's fine-print "active contact"
   definition; Fin's per-resolution fear ("I'm scared of the costs"); Tidio's
   unnotified plan doubling (€11.25→€50, twice) and per-operator + paid
   branding-removal stacking; Fresha's 20% "new client" fee charged on the
   business's own QR-code and Google-ad clients.
2. **Contract / cancellation friction** — Podium auto-renew traps, collections,
   "cancel only after a meeting"; Intercom 12-month contracts; ManyChat phantom
   cancellations; Calendly billing after pause.
3. **Unreachable support** — weeks-long waits at Podium; Tidio/ManyChat
   submit-into-the-void; Fresha months-long bank-account changes.

### New wedges surfaced by pass 2

- **Data portability as a trust feature.** Export complaints at five products:
  Podium ("YOU CANNOT EXPORT YOUR OWN DATA"), Acuity (export crashes),
  NiceJob (can't export reviews), Fin (no data export/dashboards), ManyChat
  ("no access to OUR contacts"). One-click export of contacts, bookings, and
  conversations is cheap, directly answers the top betrayal theme, and doubles
  as a competitor-import onboarding wedge.
- **White-label confirmed verbatim** — Calendly: "you can't mask the fact that
  you're using calendly", "sticks out like a sore thumb"; plus its API is
  read-only, so an API-first bookable platform is a real differentiator.
- **Keep primitives in every module's base tier.** Bundle resentment ignites
  when basics (texting, payments, branding removal) turn out to be paid
  add-ons inside a bundle the buyer thought they owned.
- **Incumbent AI is a complaint source, not a moat** — Fin "overhyped… replies
  aren't helpful" + hallucination trust damage; Lyro "can barely answer";
  Podium's voice AI detectably robotic. Grounded, cited answers + human
  handoff is the counter-position for Module 1.
- **Vertical churn is live right now:** Fresha ended "free forever" (base now
  $20/mo + billed reminder texts); SimplePractice doubled its starter plan
  $29→$49 (r/therapists revolt threads); Vagaro add-on fatigue; salon
  practitioners literally urging a developer to "build a new Fresha/Vagaro"
  (reddit.com/r/hairstylist/comments/1lha567).
- **Agency white-label demand is direct, not inferred:** r/agency threads
  request white-label review platforms (1f3zqi8) and white-label AI inbound
  call assistants (1ljjijx); GHL users resell it while hating it; GHL's
  missing WhatsApp conversational AI is a named defection reason (1h5jpup).

### Verdict changes after pass 2

- Booking = build next: **reinforced** (two-sided wedge: Calendly
  white-label/paywalled basics/seats + Fresha commission/fee creep; verticals
  churning).
- Messaging = channels: **confirmed, WhatsApp emphasized** (Tidio's most-cited
  functional gap; GHL defection reason; Mexico/LatAm quote: clients live on
  WhatsApp, not the widget).
- Reviews = add: **upgraded**. Podium's loop is loved and churn is purely
  commercial — defectors are harvestable; NiceJob proves flat/no-contract
  wins at $75/mo and MakerBay can undercut it. Mind the CRM-integration gap
  (Jobber/QuickBooks/HubSpot named).
- AI receptionist = later: **unchanged** (real pain, astroturf-heavy space,
  wrong-booking risk is a stated adoption blocker).

### Operational notes (for the next sweep)

- Bright Data: Reddit (and mirrors) refuse scraping without account KYC —
  complete brightdata.com/cp/kyc to unlock full threads. `scrape_batch` was
  flaky against G2 (timeouts/502s); single `scrape_as_markdown` calls
  succeeded 7/7. G2's `filters[nps_score][]=N` URL filter works for
  low-star-only pages.
- Apify: `automation-lab/trustpilot` good ($0.005 start + ~$0.0006/review;
  returned 0 rows for podium.com though); `memo23/capterra-scraper` good
  ($0.01 start + $0.0009/row; sort order not strictly respected);
  `azzouzana/capterra-reviews-scraper` silently caps free accounts at ~5
  results — avoid.
