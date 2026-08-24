# MakerBay — Status Board

Updated 2026-08-24. One line per item; details live in the specs and CHANGELOG.
Issue numbers refer to the running issue stream in our working sessions.

## Shipped and verified

| # | Item | Status |
|---|------|--------|
| — | Contacts, Requests, Bookings, Quotes+Invoices, Reviews, Presence, Assistant (RAG chat + embed), Payments (Stripe Connect), Voice (pending AWS enablement), Usage metering, Audit trail + Activity page | Live |
| 26 | Assistant widget: business identity header + quick chips (services / hours / contact / about) | Live |
| 27 | Sidebar redesign Variant A (grouped Work/Grow nav, icons, account popover, module tabs) | Live |
| 28 | App version in app footer/popover + marketing site, linking to changelog | Live |
| 29 | Edit page URL slug inline on Your page | Live |
| 30 | Help centre redesign: auto-generated titles/descriptions/categories from knowledge base, search, grouped index | Live |
| 31 | Marketing screenshots consistent theming | Live |
| 32 | Booking form layout broken inside chat widget (CSS leak) | Fixed |
| 33 | Share page (WhatsApp/LinkedIn/Telegram/FB/GBP steps) + QR codes on Your page | Live |
| 34 | Connect-domain flow (URL normalization, alias release on remove, honest alias_busy, re-add cycle proven on demo.makerbay.app) | Fixed |
| 35 | Test-mode billing badge instead of live Stripe text | Live |
| 36 | Genie v1 (read-only briefings over activity/bookings/requests/money/reviews/business) + /me grant merge | Live |
| — | Pricing Variant A (Free / Trade $29 / Genie $99, annual $290) on site + billing | Live |
| — | Roadmap + changelog Variant B on marketing site | Live |

## In flight (this session)

| # | Item | Status |
|---|------|--------|
| 37 | Documents start at 001 + configurable prefix (SP-Q-001, SP-INV-001). Counters seed zero, central label helpers, prefix threaded through quotes/invoices/payments/Genie/web/public pages, settings input with live preview | Code done, deploying now |

## Approved queue (in order)

1. **Manual busy blocks for diary** (~1 day) — owner can block out times so slots
   don't offer; approved 2026-08-24, starting after issue 37 ships.
2. **Genie phase 2 — writes** — tool registry in core, PendingAction
   confirmation cards, top-5 write actions, receipts, taint escalation.
3. **Sidebar phase 2** — mobile bottom nav (Requests / Diary / Quotes / More)
   with open-requests count badge.
4. **Genie commercialization** — $99 Stripe product, bundle grants via webhook,
   taster allowances (25/250/2500 msgs).
5. **Admin console P0** (~3 days, spec-admin-support.md) — staff console at
   admin.makerbay.app: tenant lookup, entitlement/grant management, usage view.
6. **Voice latency probe** (~1 week, <$100, spec-voice-live-agent.md) — founder
   steps in on AWS support blockers.
7. **Help centre remaining item** — owner-facing help settings (title,
   visibility, per-article curation) approved 2026-08-24.

## Needs founder input

- **WhatsApp surface for Genie** — founder asked what it's for. Short version:
  instead of opening the dashboard, the owner texts their Genie on WhatsApp
  ("what's tomorrow look like?", "chase INV-003") and gets the same briefings/
  actions in the channel they already live in. Costs: WhatsApp Business API
  number + Meta approval + per-conversation fees. Parked until wanted.
- **Admin P1 scope** — founder asked for clarity. P1 = impersonation ("view as
  tenant"), refunds/credits issuing, feature-flag toggles per tenant, audit
  search across tenants. P0 covers lookup + grants + usage; P1 is the
  operate-at-scale layer. Parked until P0 lands and needs emerge.

## On hold (deliberate)

- **Marketplace** — revisit at ~1000 customers.
- **Booking deposits** — revisit after payments volume.
- **Ops hygiene** (root → IAM Identity Center, CloudWatch alarms, CI pipeline,
  Cost Explorer review) — founder will revisit.
- **Admin P1** — see above.
- **WhatsApp Genie** — see above.

## Blocked on founder (quick)

- **Stripe restricted key scopes** — add write scopes (Accounts, Account Links,
  Checkout Sessions, Payment Intents, Refunds) to the rk_live key, and add
  `checkout.session.completed` + `account.updated` events to the existing
  webhook endpoint. Then I verify Connect onboarding + a live payment e2e.

## External waits

- Chime SDK Voice enablement (AWS support case).
- SES production access.
- SMS origination identity registration.

## Housekeeping

- Old demo CloudFront distribution E1NIGMQRWW00GS — approved for deletion
  2026-08-24, being removed now.
