# MakerBay — End-to-End Test Report

**Date:** 2026-09-10 · **Tester:** Kimi agent · **Scope:** makerbay.app, app.makerbay.app, api.makerbay.app, widget.makerbay.app, help.makerbay.app, mcp.makerbay.app, demo.makerbay.app
**Method:** Live HTTP/content verification of every public route, cross-checked against the repo (`site/build.mjs`, `packages/`, `CHANGELOG.md`). **Visual/browser pass was blocked** — the WebBridge browser extension was not connected, and shell-command approvals expired, so rendering, sign-in, and dashboard flows are marked BLOCKED rather than passed.

Legend: ✅ pass · ❌ defect · ⚠️ observation · ⛔ blocked (not testable this session)

---

## 1. Availability & routing

| Check | Result |
|---|---|
| Homepage `/` | ✅ 200, full content renders |
| `/pricing`, `/roadmap`, `/changelog` | ✅ all 200 |
| All 12 module pages `/modules/*` | ✅ all 200 (assistant, booking, contacts, genie, payments, presence, quotes, requests, reviews, setup, visibility, voice) |
| Legal: `/terms`, `/privacy`, `/dpa`, `/security`, `/subprocessors` | ✅ all 200 |
| `/compare/jobber`, `/for/plumbers` | ✅ 200 |
| `/robots.txt` → sitemap reference | ✅ |
| Nav "Sign in" → `app.makerbay.app` | ✅ correct target (verified in `site/build.mjs`); `makerbay.app/sign-in` 404 is expected, not a bug |
| `app.makerbay.app` | ⚠️ serves the SPA shell (title "MakerBay"); client-rendered content unverifiable without a browser |
| `api.makerbay.app/v1/core/version` | ✅ 401 unauthenticated — endpoint exists and correctly refuses anonymous callers |
| `widget.makerbay.app/widget.js` | ✅ 200, loader script served |
| `demo.makerbay.app` ("Live example page" footer link) | ✅ renders the Southside Plumbing demo: services, hours, live open/closed state, reviews, FAQ, contact |
| `help.makerbay.app` root | ⚠️ 404 — help centres live at `/{slug}`, so the bare domain has no landing page. Minor UX gap |
| `mcp.makerbay.app` root GET | ⚠️ 404 — but `packages/mcp-server/src/handler.ts` says GET should return 405 `method_not_allowed`. Suggests the deployed route mapping doesn't reach the handler at `/`. Verify the custom-domain route |
| `admin.makerbay.app` | ⛔ not verified |

## 2. Content consistency (marketing vs. shipped product)

These are real defects — marketing copy that contradicts the changelog and, in one case, the legal documents.

| # | Page | Defect | Severity |
|---|---|---|---|
| C1 | `/modules/voice` (Missed-call rescue) FAQ says: *"Does it record my calls? **No.** … there is nothing to record and nothing to transcribe."* | **High** — contradicts the **DPA Annex I** ("call recordings, kept 30 days, and transcripts, kept 90 days"), the **security page** ("call recordings after 30"), and **changelog 2.1.0** ("their voicemail is written out…"). A legal document and a marketing page cannot both be true. Decide which design is real and fix the other side |
| C2 | `/modules/booking` FAQ: *"Can I take a deposit at booking time? **Not yet**…"* | **Medium** — booking deposits shipped in **2.24.0** (Stripe deposit secures the slot) |
| C3 | `/modules/quotes` FAQ: *"Can the customer pay a deposit when they accept? **Not yet**…"* | **Medium** — deposits on accepted quotes shipped in **2.4.0** |
| C4 | `/modules/presence` FAQ: *"Can I take payment on it? **Not yet**…"* and references **"Presence Pro"** custom domains | **Medium** — Get paid is live since 2.4.0; "Presence Pro" no longer exists after the tier pricing change (2.5.0). Stale plan name |
| C5 | Homepage pricing section shows **"Pro $29"**; every other surface (pricing page, compare page, roadmap, changelog) calls the plan **"Trade"** | **Low/Medium** — naming drift. Also the homepage section appears to show only Free + Pro, while changelog 2.19.0 says "the homepage pricing section shows all three plans including Genie at $99" — needs visual confirmation (fetch may have truncated) |

Root-cause note: C2–C4 live in `modules/*/module.json` marketing blocks — the "single source of truth" itself is stale, so the generated pages inherited it.

## 3. Legal & compliance

| Check | Result |
|---|---|
| Privacy v1.1 (10 Sep 2026, Resend + passkeys) | ✅ matches changelog 2.29.0 |
| DPA v1.1 (Resend in Annex III) | ✅ matches changelog 2.29.0 |
| Terms v1.0 | ✅ unchanged, consistent (2.29.0 bumped only privacy + DPA) |
| Sub-processor list identical across privacy §6, DPA Annex III, `/subprocessors` | ✅ AWS, Stripe, Resend — all three agree |
| Security page "not in place" list = DPA Annex II "planned" list | ✅ identical, dates match |
| Honest no-SOC2/no-pentest statements | ✅ consistent across security page and DPA clause 10 |
| ❗ DPA claims call recordings exist (30-day retention) while `/modules/voice` says nothing is recorded | ❌ see C1 — this is the legal side of that contradiction |

## 4. Widget / embed surface (static review of served `widget.js`)

| Check | Result |
|---|---|
| Chat runs in a sandboxed cross-origin iframe | ✅ host page can't read the conversation |
| `postMessage` close handshake checks `e.origin === ORIGIN` | ✅ origin-validated |
| Requires `data-key` or `data-slug`, errors plainly otherwise | ✅ |
| Docs snippet (`data-key="mb_pk_…"`) matches loader behaviour | ✅ |
| Interactive behaviour (open, ask, book) | ⛔ needs a browser |

## 5. Dashboard app (app.makerbay.app)

⛔ **Entire category blocked.** The app is a client-rendered SPA; without browser control I could verify only that the shell HTML is served. Not tested: sign-in with emailed code, passkeys, onboarding, Home checklist, module screens (Contacts, Requests, Quotes, Bookings, Reviews, Assistant, Genie, Page, Payments), billing, support tickets, mobile bottom nav.

## 6. End-to-end customer journeys

⛔ **Blocked** (all require browser interaction): demo booking flow, chat widget Q&A on the demo page, quote accept/decline, workspace signup, Stripe connect.

## 7. Code-level suite

⛔ `npm test` (vitest) not run — shell approvals expired this session.

---

## Summary

- **20+ public routes verified live and rendering** — the marketing/legal surface is in good shape structurally.
- **5 content defects found**, all the same root cause: `module.json` marketing blocks (and one homepage section) predate shipped features. **C1 is the one to fix first** — it puts the DPA and a marketing page in direct contradiction.
- **Not visually tested:** the entire dashboard and every interactive flow. To finish the E2E pass I need either the WebBridge extension connected in your browser (so I can drive your real session, including sign-in) or the in-app browser enabled. Say the word and I'll run the visual/interactive half and append it to this report.
