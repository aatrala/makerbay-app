# MakerBay — Status Board

Updated 2026-08-24 (late evening). One line per item; details live in the
specs and CHANGELOG. Issue numbers refer to the running issue stream.

## Latest batch (issues 38-42, v2.13.0)

| # | Item | Status |
|---|------|--------|
| 38 | Genie visible in every account (taster merged into /me); dynamic module-aware chips in Genie; business-specific chips (top service, service areas) in the chat widget | Live |
| 39 | Preview section: segmented Desktop/Phone switch, Refresh + Open aligned in one control group, phone bezel frame, responsive heights | Live |
| 40 | Connect domain "not functioning" root-caused: the founder's personal workspace is on Free - the 402 Presence-Pro gate refused the PUT (no bug in the domain flow; nothing was created). Fixed twice: founder workspace seeded with a Presence Pro comp (scripts/seed-founder-grants.mjs), and the card now shows the plan requirement BEFORE typing instead of erroring after submit | Live |
| 41 | Multiple slugs per workspace (3 on Trade / 5 on Genie, upsell on Free) | Proposal sent, awaiting go |
| 42 | Help centre not findable - it was buried at the bottom of Assistant → Behavior. Now its own "Help centre" tab in the Assistant nav | Live |

Founder workspace (Aatral Arasu, slug aatralarasu) now carries founder comps:
presence pro + genie pro 2500, seeded 2026-08-24.

## Shipped and verified

| # | Item | Status |
|---|------|--------|
| — | Contacts, Requests, Bookings, Quotes+Invoices, Reviews, Presence, Assistant (RAG chat + embed), Payments (Stripe Connect), Voice rescue (pending AWS enablement), Usage metering, Audit trail + Activity page | Live |
| 26 | Assistant widget: business identity header + quick chips | Live |
| 27 | Sidebar redesign Variant A + **phase 2 mobile bottom nav** (Requests badge / Diary / Quotes / More) | Live |
| 28 | App version in app + marketing site, linking to changelog | Live |
| 29 | Edit page URL slug inline on Your page | Live |
| 30 | Help centre redesign + **owner article curation** (edit title/description/category per article, Rewrite with AI) | Live |
| 31 | Marketing screenshots consistent theming | Live |
| 32 | Booking form layout in chat widget (CSS leak) | Fixed |
| 33 | Share page + QR codes | Live |
| 34 | Connect-domain flow fixes, proven on demo.makerbay.app | Fixed |
| 35 | Test-mode billing badge | Live |
| 36 | Genie v1 read-only + /me grant merge | Live |
| 37 | Documents start at 001 + configurable prefix (SP-Q-001). Verified live: existing numbers untouched, new quote = SP-Q-005, public pages serve labels | Live |
| — | **Busy blocks**: block out owner time from the diary; slots refuse it, cap ignores it. Verified live (13:00-15:00 block removed exactly those slots) | Live |
| — | **Genie phase 2 writes**: send quote/invoice, cancel/complete booking, block time — server-held confirmation cards, executed via module APIs with the owner's own token, receipts + audit trail. Verified e2e (propose → confirm → diary; replay refused) | Live |
| — | **Genie plan commercialized**: $99/mo Stripe product (Trade bundle + 2500 Genie msgs), taster allowances 25 free / 250 Trade applied at runtime, Billing upgrade card | Live |
| — | **Admin console P0**: find-by-email, Tenant 360 (webhook health, Connect state, users, page/domain, source count), audited password resets, suspend/unsuspend enforced in slug resolution + authorizer, docs/runbook-support.md | Deployed 2026-08-24 |
| — | Pricing Variant A + roadmap/changelog Variant B on site | Live |
| — | Old demo CloudFront distribution E1NIGMQRWW00GS | Deleted 2026-08-24 |

## Next up (approved, on me)

1. **Voice latency probe** (Stage 1, ~1 week, <$100 — spec-voice-live-agent.md):
   one Connect instance + DID + Nova 2 Sonic handler, dual-channel recorded
   PSTN calls. Gate: median <1,200ms AND p95 turn <900ms. Next dedicated
   session; founder steps in on AWS support blockers.

## Needs founder input

- **WhatsApp surface for Genie** — what it is: the owner texts their Genie on
  WhatsApp ("what's tomorrow?", "chase INV-003") instead of opening the app;
  same briefings and confirmation cards, in the channel tradies already live
  in. Costs: WhatsApp Business API number, Meta business verification, and
  per-conversation fees (~USD 0.5-8c each). Say go and it queues behind the
  voice probe; otherwise stays parked.
- **Admin P1 scope** — spec G5-G8 (~4-5 days): SES suppression list view +
  removal, read-only conversation viewer for wrong-AI-answer tickets,
  scripted audited privacy export/delete, audit log reader page. Recommended
  before the first 100 customers; pick any subset.

## Blocked on founder (quick)

- **Stripe restricted key scopes** — add write scopes (Accounts, Account
  Links, Checkout Sessions, Payment Intents, Refunds, and now Products +
  Prices + Subscriptions for the Genie plan product) to the rk_live key; add
  `checkout.session.completed` + `account.updated` to the webhook endpoint.
  Then I verify Connect onboarding + a live payment + Genie checkout e2e.

## External waits

- Chime SDK Voice enablement (AWS support case) — gates voice rescue go-live.
- SES production access.
- SMS origination identity registration.

## On hold (deliberate)

- Marketplace (revisit ~1000 customers). Booking deposits. WhatsApp Genie
  (pending founder read on the note above). Admin P1 (pending scope pick).
- Ops hygiene (root → IAM Identity Center, alarms, CI, Cost Explorer) —
  founder will revisit; worth a look after this week's five deploys.

## Notes

- Suspension enforcement caveat: authorizer results are cached per header, so
  a suspension bites on public pages immediately but on the dashboard within
  a few minutes. Documented in runbook-support.md.
- First staff account needs the CLI bootstrap in runbook-support.md (the
  console has no self-serve staff signup, by design).
