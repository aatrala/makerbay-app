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

## Pass 2 — Bright Data + Apify deep-dive (2026-08-23, in progress)

Now that Bright Data (unblocked G2/Reddit scraping) and Apify (structured
Capterra/Trustpilot review pulls) are connected, pass 2 targets exactly the
gaps above. Results will be appended here when the runs complete:

- [ ] Reddit deep-dive: vertical subs, agency/reseller, review-mgmt demand,
      missed-call threads — real permalinks + verbatim quotes
- [ ] G2 actual review text: Podium, Calendly, NiceJob, Tidio, Intercom,
      Manychat critical reviews; settle Acuity/Podium rating disputes
- [ ] Apify structured reviews: Capterra/Trustpilot pros/cons for Podium,
      Calendly, Tidio, Fresha; star-distribution skew across platforms
