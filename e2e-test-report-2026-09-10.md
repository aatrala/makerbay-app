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


---

# Visual Pass Addendum (2026-09-10, ~23:30 AEST — browser-driven via WebBridge)

Closes the three sections left ⛔ above. Method: real Chrome driven over Kimi WebBridge, ~40 JPEG screenshots (`.shots/`), signed in as `aatrala+b1@gmail.com` (workspace "Test page").

## 5. Dashboard app — now ✅ tested

| Flow | Result |
|---|---|
| Code sign-in | ✅ Email → "Email me a code" → "Check your email … works once, expires in ten minutes" → code `989113` accepted → lands on `/home`. Passkey + legacy password links both present |
| Home / Getting started | ✅ Progress bar (0 of 3), single "Next" action, "Set it up for me" CTA |
| Requests | ✅ Inbox/Settings tabs, All/New/Open/Closed filters, empty state names the next action |
| Bookings (Diary/Services/Hours) | ✅ Diary timezone-aware ("in Asia/Calcutta"), "Block out time" present, honest empty state |
| Quotes (+ Invoices, Price list) | ✅ Status tabs incl. expired; "New quote" CTA |
| Get paid | ✅ "Connect with Stripe" card, "MakerBay never holds your money", empty payments list |
| Contacts, Reviews, Get found | ✅ All render; Get found shows the 8-step Google profile checklist |
| Genie | ✅ Quick chips (Tomorrow's bookings / Diary / Money / Block time / +), free-text input |
| Assistant (Playground/Knowledge/Behavior/Help centre/Deploy/Conversations/Insights) | ✅ "No knowledge yet — your assistant will decline every question" warning, sample chips |
| **Your page → Preview** | ❌ **V1 (Medium): the live preview iframe renders a raw "That page doesn't exist" 404 — with the marketing site header/footer inside the preview frame — for a workspace whose page isn't published yet.** Should be an in-product placeholder ("your page appears here once it has an intro/photo/priced service"), not the public 404 |

## 6. Customer journeys — now ✅ tested

| Journey | Result |
|---|---|
| Homepage hero demo | ✅ Click-to-load by design; plays Q→cited answer→booking chips→"Booked … confirmation sent ✓" |
| HQ assistant, unknown question | ✅ Asked an off-topic plumbing question: it **declined** ("I don't have that answer yet"), offered fallback links, cited "About MakerBay", thumbs up/down shown — the core honesty claim, working |
| HQ booking flow | ✅ Service card ("Setup session, 45 min, **$99 deposit**" — deposits visibly live) → weekday-only day list → picked Fri 11 Sep → honest "Nothing free that day — try another" empty state. Stopped before payment by design |
| Demo (Southside) grounded Q&A | ✅ "Yes, we cover Marrickville. A leak inspection and quote is $90 for 30 minutes…" with **4 named sources** + feedback buttons |
| Demo full booking | ✅ Service → Fri 11 Sep → 16:30 → details → **"✓ Booked — confirmation email is on its way, with a link if you need to cancel"** |
| Widget overflow | ⚠️ **V2 (Low): in the 380px chat bubble on demo.makerbay.app, the quick-chip row is cut off at the right edge** (no wrap/scroll affordance). Full-width surface renders fine |
| Link wrap | ⚠️ V3 (trivial): a URL in an assistant answer broke mid-hostname across lines ("app.makerbay.a pp") |

**Cleanup needed:** the test booking **Fri 11 Sep 2026, 16:30, "E2E Test", aatrala+b2@gmail.com** now exists in the Southside demo workspace and a real confirmation email was sent — cancel it from the demo diary or via the email's cancel link.

## 7. Unit tests — now ✅ tested

`vitest run`: **52 files, 515 tests, 515 passed** (14.9s, Node v24.15.0).

## Verdict after visual pass

All previously ⛔ sections pass except **V1** (page-preview 404, medium UX) and **V2** (chip overflow, low). Combined with the earlier fixes in commit `58ec115`, no known defect above "low" remains open other than V1.

---

# Write-Workflow Pass Addendum (2026-09-11, browser-driven, workspace `test-page`)

The earlier passes were read-only. This pass **entered real data and exercised every logged-in workflow end-to-end** in the owner's Chrome (WebBridge), signed in as `aatrala+b1@gmail.com`, customer identity `aatrala+b2@gmail.com`. Evidence: `.shots/w2b-*` … `.shots/w7-*` screenshots + JSON logs.

## 8. Booking workflow (Bookings module)

| Step | Result |
|---|---|
| Create service "E2E Test Service" (30 min +15 buffer, $120, bookable) | ✅ Appears in "What you offer" table, toast "Added." |
| Customer books it on `chat.makerbay.app/booking?slug=test-page` | ✅ Service → day list (Fri 11 Sep … 14 weekdays shown) → time slots (12:30–16:30) → details form → **"✓ Booked — E2E Test Service, Friday 11 September 2026 at 12:30"** + cancel-link email promised |
| Same-day evening booking attempt (previous run, ~19:2x Calcutta) | ✅ Correctly refused ("Nothing free that day") — 12 h shortest-notice honoured |
| Contact auto-created from booking | ✅ "E2E Workflow Customer · aatrala+b2@gmail.com · new · 2 min ago" in Contacts — cross-module auto-fill claim verified |
| Block out time (Sat 12 Sep 09:00–12:00, "E2E test block") | ✅ Appears in diary list with status "blocked"; one-click **Remove** works; list returns to empty state |
| **Booking visible to the owner afterwards** | ❌ **V4 (High)** — see below |

### ❌ V4 (High, NEW): Confirmed booking is invisible to the owner

- Customer side said "✓ Booked … confirmation email on its way"; a **contact was created server-side** from the same submission.
- Owner **Diary** (`/booking/diary`, fresh reloads over ~30 min): still "Nothing booked yet".
- **Requests** inbox: "No requests yet" (booking is not pending-approval there either).
- **Genie**, asked "What is booked this week?": *"Nothing booked this week. Your diary is clear. checked: bookings"* — the bookings data layer itself has no trace.
- Conclusion: the booking write creates the contact but the booking record never lands in (or is never read back into) the diary. **A tradesperson would never show up to a job the customer thinks is booked.** This contradicts the product's core loop and should be investigated with the booking API/server logs for `test-page` around 2026-09-10 ~23:5x local. (Note: the earlier Southside *demo* booking also needs checking against the demo diary — same code path.)

## 9. Quotes & invoices (Quotes module) — all ✅

| Step | Result |
|---|---|
| Price list: add "E2E Labour · hour · $95.00" | ✅ Saved, listed with Remove; quote settings (tax, validity days, currency picker with 10+ currencies) render |
| New quote → pick **existing customer** from dropdown | ✅ "E2E Workflow Customer (aatrala+b2@gmail.com)" — contacts reused across modules again |
| Add line from price list, qty 2 | ✅ Line total and quote total compute live ($190.00) |
| Create draft | ✅ **Q-001**, totals correct, "Valid until 11 October 2026" (30-day default from settings) |
| "Get the link" | ✅ Reveals public link `quote.makerbay.app/test-page/Q-001/<token>`; **side effect: quote status draft → sent just by revealing the link** (worth a product decision — nothing was actually sent) |
| Public quote page (customer view) | ✅ Clean doc: lines, totals, validity, terms; "Type your name" + "Yes — go ahead at this price" / "No thanks"; print/PDF and QR options |
| Customer accepts | ✅ "Accepted by E2E Workflow Customer. Test page has been told…" |
| Owner view after acceptance | ✅ Status → **accepted**, quote frozen ("cannot be sent again"), **open tracking** ("Opened 2 times, last on 11 September"), next steps offered |
| Create invoice | ✅ **INV-001**, lines copied exactly, status draft, due 25 Sep 2026, actions: Send invoice / Mark paid / Void / Get the link; appears in Invoices list |

## 10. Assistant (knowledge → grounded answers) — all ✅

| Step | Result |
|---|---|
| Paste-text knowledge source "E2E Workshop Policy" (42-day guarantee) | ✅ "Added. It will be ready to…" |
| Playground, question **covered** by knowledge | ✅ "We offer a 42-day satisfaction guarantee… redo the work free of charge." + **"Based on E2E Workshop Policy"** provenance + 👍/👎 |
| Playground, question with **empty** knowledge base | ✅ Honestly declines: "I don't have that information yet. Please contact the team directly." — no invention, as promised |

## 11. Genie (business data Q&A) — all ✅

| Question | Answer observed |
|---|---|
| "How is my latest quote doing?" | ✅ "…your latest one was **accepted**. You do have a **draft invoice for E2E Workflow Customer worth $190.00** sitting there. Want me to send it?" + `checked: money` provenance — real records, real numbers |
| "What is booked this week?" | "Nothing booked this week. Your diary is clear. `checked: bookings`" — *consistent, but wrong because of V4* |
| Quota display | "24 Genie messages left this month" shown after answers (did not visibly decrement between two questions — cosmetic, unverified) |

## 12. Your page & Home checklist

| Step | Result |
|---|---|
| Fill headline/intro/areas/email → **Save page** | ✅ Toast "Saved — the preview shows it now. Visitors see it within about 5 minutes." Page checklist 2 → **3 of 7** |
| Preview iframe (`makerbay.app/p/test-page?preview=2`) | ❌ **V1 upgraded Medium → High**: even *after* saving real content and pressing **Refresh**, the preview still shows "That page doesn't exist" — directly contradicting the "Saved — the preview shows it now" toast |
| Home "Getting started" checklist | ⚠️ **V5 (Low, NEW)**: stuck at "1 of 3". "Say when you are free" never ticks even though hours (Mon–Fri 09:00–17:00) exist and the booking page honours them. Either the check looks at the wrong signal, or setup never marks hours saved |

## 13. Defect summary after write pass

| ID | Severity | Defect | Status |
|---|---|---|---|
| **V4** | **High** | Confirmed booking never appears in owner Diary / Requests / Genie (`checked: bookings`) — contact IS created | ✔ FIXED 2026-09-11 (t07), see resolution log 2 |
| **V1** | **High** (was Medium) | Page preview iframe 404s ("That page doesn't exist") even after content saved + Refresh, while the UI claims "the preview shows it now" | ✔ FIXED 2026-09-11 (t08) |
| V5 | Low | Home checklist "Say when you are free" never ticks despite configured, working hours | ✔ FIXED 2026-09-11 (t09) |
| V2 | Low | Chat-bubble quick-chip row overflows 380 px panel | ✔ FIXED 2026-09-11 (t10) |
| V3 | Trivial | URL wraps mid-hostname in assistant answer | ✔ FIXED 2026-09-11 (t11) |

## 14. Test data left behind (cleanup list for the owner)

In workspace **test-page** (sign in as aatrala+b1@gmail.com):
1. Service "E2E Test Service" ($120/30 min) — Bookings → Services.
2. A phantom booking for **Fri 11 Sep 2026 12:30** (customer "E2E Workflow Customer") — invisible in the diary (V4) but may exist server-side; a confirmation email went to aatrala+b2@gmail.com with a cancel link — **use it**.
3. Contact "E2E Workflow Customer" (aatrala+b2@gmail.com).
4. Price-list item "E2E Labour" $95/hr.
5. Quote **Q-001** (accepted, $190) and invoice **INV-001** (draft, $190) — invoice can be **Void**ed; quote is frozen but its link can be stopped ("Stop this link working").
6. Knowledge source "E2E Workshop Policy" (42-day guarantee) — Assistant → Knowledge.
7. Page content (headline/intro) on Your page — page remains unpublished.
8. In the **Southside demo** workspace: booking Fri 11 Sep 2026 16:30 "E2E Test" (from the earlier pass) — cancel via its email link.

## 15. Still not covered (pending)

- Activity feed (what each action looks like as plain sentences) — script ready, awaiting browser approval.
- Sign-out flow — script ready, same batch.
- Get found / Reviews / Payments (Stripe connect) write paths — Payments needs real Stripe credentials, out of scope; Get found + Reviews are read-mostly but their "send review request" write path is untested.
- Email deliverability/content (confirmation, quote, invoice emails) — only the recipient inbox (yours) can confirm these.

---

## Resolution log 2 (2026-09-11, write-pass findings)

Reviewed by Claude with three independent code investigations, then fixed, deployed and verified live.

| Item | Finding | Root cause | Outcome | Verified |
|---|---|---|---|---|
| t07 | **V4** booking invisible to owner | Regression from the deposits release (26 Aug): on the no-deposit path the only write of the booking row sat inside the "confirmation email failed" branch. While customer email was failing (SES sandbox) it always ran; from the Resend cutover on 8 Sep every no-deposit booking was confirmed to the customer, contact created, owner emailed, reminder scheduled, and **never stored**. | Row is written before any side effect; regression test `modules/booking/api/src/create-booking.test.ts` pins put-before-mail. | Live: a booking via `POST /v1/public/booking` on `test-page` stored as `confirmed`, `emailed: true`; row then removed. **Blast radius:** zero booking rows since 8 Sep, three orphaned reminder schedules (the tester's three bookings); no real customer affected. Orphaned schedules deleted. |
| t08 | **V1** page preview 404 | Two causes. (1) The preview iframe appended `?preview=<n>` as a cache-buster; the public page route treats any `preview` value as a prospect-preview token and 404s when it is not one, so the preview failed for **every** workspace. (2) An unpublished page is a 404 by design, while the Save toast promised "the preview shows it now". | Cache-buster renamed to `?v=`; the route only treats token-shaped values as prospect previews; not-found answers are `no-store` so a just-published page is not a 404 at the edge for five minutes; for an unpublished page the pane now shows the saved page rendered server-side with the note "Not published yet ... Visitors get page not found until you tick Publish", and the Save toast says the same. | Live: `makerbay.app/p/makerbay-demo?preview=2` answers 200 (was 404). |
| t09 | V5 checklist step never ticks | Home keyed the step on `config.updatedAt`, which the booking config save never wrote. | Save stamps `updatedAt`; GET also returns `saved` so hours saved before today tick too; Home reads either. | Typecheck + unit suite; visible on next dashboard load. |
| t10 | V2 chip row clipped at 380px | Horizontal scroller with its scrollbar hidden and no cue. | Right-edge fade, scroll snap, trailing space. | `chat.css` published; live CSS carries the rule. |
| t11 | V3 URL wraps mid-hostname | `word-break: break-all` on answer links. | `overflow-wrap: anywhere; word-break: normal`. | Same publish. |
| t12 | "Get the link" flips draft → sent | Deliberate since issue 118: the link is what makes the price binding, so it locks editing like an email send. Undocumented in the spec. | Note under the button says so; `/share` added to spec section 3.4. Behaviour unchanged. | — |

**Still open:** section 14 test-data cleanup (owner/tester, via the UI); section 15 pending flows (activity feed, sign-out, review request send path, email content in a real inbox). Genie quota not visibly decrementing (section 11) was not investigated.
