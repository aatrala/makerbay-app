# MakerBay — End-to-End Test Report

**Date:** 2026-09-10 · **Tester:** Kimi agent · **Scope:** makerbay.app, app.makerbay.app, api.makerbay.app, widget.makerbay.app, help.makerbay.app, mcp.makerbay.app, demo.makerbay.app
**Reviewed and actioned 2026-09-10 by Claude (commit `58ec115`); resolutions are marked ✔ FIXED / ✖ NOT A DEFECT inline and summarised at the end.**

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
| `help.makerbay.app` root | ✔ FIXED (t05) — was 404; now renders a landing page explaining that each business has its own centre at `help.makerbay.app/{page-name}` |
| `mcp.makerbay.app` root GET | ✖ NOT A DEFECT — the MCP route is `/mcp`, behind an authorizer: anonymous GET `/mcp` answers 401 before the handler's 405 can run, and `/` is API Gateway's default 404 for an unmapped path |
| `admin.makerbay.app` | ⛔ not verified |

## 2. Content consistency (marketing vs. shipped product)

These are real defects — marketing copy that contradicts the changelog and, in one case, the legal documents.

| # | Page | Defect | Severity |
|---|---|---|---|
| C1 | `/modules/voice` (Missed-call rescue) FAQ says: *"Does it record my calls? **No.** … there is nothing to record and nothing to transcribe."* | **High** — contradicts the **DPA Annex I** ("call recordings, kept 30 days, and transcripts, kept 90 days"), the **security page** ("call recordings after 30"), and **changelog 2.1.0** ("their voicemail is written out…"). A legal document and a marketing page cannot both be true. Decide which design is real and fix the other side. **✔ FIXED (t01):** the DPA was the true side. `modules/voice/api/src/processor.ts` transcribes voicemails that land in S3, so the FAQ now says calls are not recorded but a voicemail the caller leaves is recorded, written out, and kept 30 days (transcript 90) |
| C2 | `/modules/booking` FAQ: *"Can I take a deposit at booking time? **Not yet**…"* | **Medium** — booking deposits shipped in **2.24.0** (Stripe deposit secures the slot). **✔ FIXED (t02):** the answer now describes the deposit flow, and the module's status note no longer says deposits are out of scope |
| C3 | `/modules/quotes` FAQ: *"Can the customer pay a deposit when they accept? **Not yet**…"* | **Medium** — deposits on accepted quotes shipped in **2.4.0**. **✔ FIXED (t03)** |
| C4 | `/modules/presence` FAQ: *"Can I take payment on it? **Not yet**…"* and references **"Presence Pro"** custom domains | **Medium** — Get paid is live since 2.4.0; "Presence Pro" no longer exists after the tier pricing change (2.5.0). Stale plan name. **✔ FIXED (t04):** payments answer rewritten; custom domains attributed to the Trade plan |
| C5 | Homepage pricing section shows **"Pro $29"**; every other surface (pricing page, compare page, roadmap, changelog) calls the plan **"Trade"** | **Low/Medium** — naming drift. Also the homepage section appears to show only Free + Pro, while changelog 2.19.0 says "the homepage pricing section shows all three plans including Genie at $99" — needs visual confirmation (fetch may have truncated). **✖ NOT REPRODUCED:** the live homepage names the plan Trade (five occurrences, zero of "Pro") and shows all three prices; the fetch was truncated as suspected |

Root-cause note: C2–C4 live in `modules/*/module.json` marketing blocks — the "single source of truth" itself is stale, so the generated pages inherited it. **Resolution:** the four `module.json` files were corrected at the source and the site rebuilt and published, so every generated surface (module page, roadmap, version endpoint) agrees again.

## 3. Legal & compliance

| Check | Result |
|---|---|
| Privacy v1.1 (10 Sep 2026, Resend + passkeys) | ✅ matches changelog 2.29.0 |
| DPA v1.1 (Resend in Annex III) | ✅ matches changelog 2.29.0 |
| Terms v1.0 | ✅ unchanged, consistent (2.29.0 bumped only privacy + DPA) |
| Sub-processor list identical across privacy §6, DPA Annex III, `/subprocessors` | ✅ AWS, Stripe, Resend — all three agree |
| Security page "not in place" list = DPA Annex II "planned" list | ✅ identical, dates match |
| Honest no-SOC2/no-pentest statements | ✅ consistent across security page and DPA clause 10 |
| ❗ DPA claims call recordings exist (30-day retention) while `/modules/voice` says nothing is recorded | ✔ FIXED — see C1; the DPA stands, the marketing page was corrected |

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

---

## Resolution log (2026-09-10, commit `58ec115`)

| Item | Finding | Outcome | Verified live |
|---|---|---|---|
| t01 | C1 voice recording contradiction | ✔ Fixed: FAQ now matches the DPA (voicemail recorded and transcribed, 30/90-day retention; answered calls never recorded) | `/modules/voice` says "written out"; "nothing to record" gone |
| t02 | C2 booking deposits "not yet" | ✔ Fixed: deposit flow described; status note corrected | `/modules/booking` says "secure the slot"; no "Not yet" |
| t03 | C3 quote deposits "not yet" | ✔ Fixed | `/modules/quotes` says "moment they accept" |
| t04 | C4 presence payments + "Presence Pro" | ✔ Fixed: payments live; plan named Trade | `/modules/presence` says "Trade plan"; no "Presence Pro" |
| t05 | help.makerbay.app root 404 | ✔ Fixed: landing page served by the help renderer (`renderLanding`), cached an hour | root answers 200 "Help centres on MakerBay" |
| t06 | (not in report) Cognito password page offered "Create an account" | ✔ Fixed: user pool self sign-up off; legacy `?auth=cognito` page points new people at the code sign-in | Cognito managed-login page no longer shows the link |
| — | C5 homepage "Pro $29" | ✖ Not reproduced; truncated fetch | homepage shows Trade $29 and Genie $99 |
| — | mcp.makerbay.app root 404 | ✖ Not a defect (route is `/mcp`, authorizer answers first) | `/mcp` → 401 |
| — | api `/v1/core/version` 401 | ✖ Correct behaviour, as the report says | — |

**Still open from this report:** sections 5, 6 and 7 (dashboard, customer journeys, `npm test`) remain ⛔ until the tester has a browser. Suggested first flows once they do: code sign-in, the fingerprint offer card on Home, Workspace → People invite and join, a demo booking with a deposit, and the chat widget on demo.makerbay.app.

