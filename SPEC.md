# MakerBay — Platform Core + Assistant Module Specification

**Version:** 0.4 (M0-M4 shipped; Contacts shipped; scope reconciled with the
settled module portfolio in `modules/*/module.json`)
**Date:** 2026-08-24
**Domain:** makerbay.app
**AWS account:** 953146692138 · profile `makerbay` · region `us-east-1`
**Budget guardrail:** $80/month AWS budget with alerts (already live)

---

## 1. What we are building

MakerBay is a modular B2B SaaS platform for SMBs. Businesses subscribe to a base
plan and enable capability **modules** as plugins. Every module is API-first:
usable from the MakerBay dashboard, via REST API with tenant API keys, and via
MCP.

**The module portfolio and its order are settled** and live in
`modules/*/module.json`, which also generates the public roadmap at
makerbay.app/roadmap. The order is a dependency chain, not a preference:

| # | Module | Status |
|---|---|---|
| 1 | **Contacts** (core, never entitlement-gated) | shipped |
| 1 | **Assistant** | shipped |
| 2 | **Requests** — handoff, lead capture, feedback | shipped |
| 3 | **Bookings** (now with reminders) | shipped |
| 4 | **Quotes** (now with revisions and simple invoices) | shipped |
| 5 | **Reviews** | shipped |

**This spec covers:**

1. **Platform core (thin):** tenancy, auth, entitlements, API keys, usage metering.
2. **Contacts:** the customer list every other module writes to. Core, so it is
   never switched off — a module cannot depend on something a customer might
   have disabled, and modules that each keep their own customer list can never
   be joined up afterwards.
3. **Module 1 — Assistant:** a RAG chatbot an SMB trains on its own documents and
   deploys as an embeddable widget, a hosted chat page, a public help centre,
   or an API.
4. **Reviews module (planned scope, not for immediate build):** review
   requests, the embeddable review wall, and a later monitoring/AI-reply
   stage — working scope in §5, aligned to `modules/reviews/module.json`.

Anything a module is, does or costs belongs in its manifest, not here. This
document covers the platform seams and the acceptance criteria; the manifests
are the source of truth for the modules themselves.

### Goals

- A live, end-to-end product: SMB signs up → uploads docs → tests bot → embeds widget.
- Every platform seam (tenancy, entitlements, metering) exercised for real by module 1.
- Total AWS cost at zero/low traffic: under $15/month.

### Non-goals (deferred, with triggers)

- ~~Stripe billing integration~~ — shipped, live keys installed.
- ~~MCP server~~ — shipped at mcp.makerbay.app.
- Additional modules — settled order lives in the `modules/*/module.json`
  manifests (which drive makerbay.app/roadmap): Contacts (core, shipped) →
  Requests → Bookings → Quotes → Reviews (§5). Messaging was dropped as a
  module; help centre and lead-capture forms are features of Assistant and
  Requests, not modules.
- ~~Custom domain email (SES)~~ — domain identity, DKIM and a custom MAIL FROM
  are provisioned ahead of Requests, because production access is reviewed by a
  person and has a lead time. Sandbox exit is still pending.
- Multi-region, WAF, provisioned capacity — per stage triggers in architecture notes.

---

## 2. Architecture summary

- **Frontend:** React (Vite) SPA on S3 + CloudFront at `app.makerbay.app`.
  Marketing site at `makerbay.app` (static, same pipeline). Widget script at
  `widget.makerbay.app`, hosted chat at `chat.makerbay.app`.
- **API:** API Gateway **HTTP API** at `api.makerbay.app`, routes `/v1/<module>/*`
  and `/v1/core/*`. Lambda authorizer (cached 300s) resolves caller → tenant +
  entitlements. One Lambda per module (modular monolith), Node.js 22 / TypeScript, arm64.
- **Data:** DynamoDB on-demand, tables per entity (no single-table design yet),
  every item partitioned by `tenantId`. Point-in-Time Recovery on.
- **AI:** Amazon Bedrock — Knowledge Base with **managed vector store** (not
  OpenSearch Serverless — $700/mo trap) over per-tenant S3 prefixes. Claude
  (cheapest adequate tier) for generation; citations from KB retrieval.
- **Events:** EventBridge bus `makerbay` — usage events, ingestion status events.
- **Auth:** Cognito user pool (dashboard users), API keys (machine access, hashed).
- **IaC:** CDK (TypeScript), single stack to start. Deploy = `cdk deploy` locally,
  GitHub Actions on push to `main` once repo exists.
- **DNS/TLS:** Route 53 hosted zone `makerbay.app`, one wildcard ACM cert
  `*.makerbay.app` (us-east-1).

---

## 3. Platform core

### 3.1 Tenancy

- `Tenants` table: `tenantId` (ULID), name, slug (for `chat.makerbay.app/<slug>`),
  plan, status, createdAt.
- Every other table keys on `tenantId` as partition key or prefix. No code path
  may query without a tenant scope. This rule is enforced in a shared data-access
  package — module code never hand-writes table access without it.

### 3.2 Identity & access

| Caller | Credential | Resolved by |
|---|---|---|
| Dashboard user | Cognito JWT | Authorizer: JWT → userId → membership → tenantId |
| SMB backend (API) | Secret API key `mb_sk_...` | Authorizer: SHA-256 lookup in `ApiKeys` table |
| Chat widget / hosted page (public) | Publishable key `mb_pk_...` | Authorizer: lookup; **scope limited to `chat:invoke` only** |

- `Users` table: userId (Cognito sub), email, tenantId, role (`owner`/`member`).
- `ApiKeys` table: keyId, tenantId, hash, scopes, label, createdAt, lastUsedAt.
  Secret keys shown once at creation. Publishable keys embeddable, chat-only.
- MVP: one tenant per user (owner). Invites deferred.

### 3.3 Entitlements

- `Entitlements` table: tenantId → { moduleId → { enabled, plan, limits } }.
- Authorizer injects entitlements into request context; module Lambda rejects
  calls for disabled modules (defense in depth — gateway route check + code check).
- MVP: enabling a module is an API call/dashboard toggle (no payment gate).
  Free-tier limits enforced: e.g. assistant `messagesPerMonth: 200` on free plan.

### 3.4 Usage metering

- Modules emit events to EventBridge: `{ tenantId, moduleId, metric, quantity,
  idempotencyKey, ts }` — e.g. `assistant.message`, `assistant.tokens`,
  `assistant.ingest.pages`.
- Aggregator Lambda upserts daily counters into `Usage` table:
  PK `tenantId#yyyy-mm`, SK `moduleId#metric#dd`.
- Dashboard reads `Usage` for the usage screen; limits checked against
  month-to-date counters. Stripe reporting bolts onto this table later — the
  event schema is the contract that must stay stable.

---

## 4. Assistant module

### 4.1 Knowledge ingestion

- Sources per tenant: file upload (PDF, DOCX, MD, TXT — presigned S3 PUT to
  `knowledge/{tenantId}/…`), pasted text, URL list (single-page fetch at MVP;
  crawling deferred).
- `Sources` table: sourceId, tenantId, type, name, s3Key, status
  (`processing` → `ready` / `failed`), sizeBytes, updatedAt.
- Bedrock Knowledge Base sync per tenant scope; ingestion completion flips
  status and emits `assistant.ingest.pages` usage event.
- Limits (free plan): 20 sources, 25 MB total. Enforced at presign time.

### 4.2 Chat runtime

- `POST /v1/assistant/chat` — body `{ sessionId?, message }`, response
  **streamed** (Lambda response streaming via function URL behind CloudFront;
  non-streaming fallback route through API Gateway for API consumers).
- Pipeline: entitlement + limit check → KB retrieval (tenant-scoped) →
  Claude generation with tenant's persona/instructions → stream tokens →
  persist exchange → emit usage events.
- Response carries `citations: [{sourceId, name, excerpt}]`.
- Fallback: if retrieval confidence low or model declines, use tenant-configured
  fallback message; optionally prompt for email (stored as `Leads` row).
- `Conversations` table: PK `tenantId#sessionId`, SK `ts`, role, text,
  citations, feedback (`up`/`down`/null), fallbackTriggered.
- Bot config in `AssistantConfig` table: name, greeting, instructions/tone,
  brandColor, logoUrl (S3), fallbackMessage, leadCapture on/off.

### 4.3 Delivery surfaces

1. **Playground** — dashboard chat pane, same API, shows citations. Ships first.
2. **Widget** — `widget.makerbay.app/widget.js` (vanilla JS, <15 KB) injects an
   iframe hosting the chat UI; snippet carries `data-key="mb_pk_…"`. Iframe
   isolation: no host-page DOM access, strict CSP.
3. **Hosted page** — `chat.makerbay.app/{slug}`, same chat component standalone,
   tenant branding.
4. **API** — documented `POST /v1/assistant/chat` with secret key. cURL example
   in dashboard Deploy tab.

### 4.4 Dashboard screens (React)

- **Knowledge:** source list + status chips, upload/paste/URL inputs, delete.
- **Behavior:** bot config form with live preview.
- **Playground:** chat + citations + "why this answer" (retrieved chunks).
- **Deploy:** three tabs (Embed / Hosted page / API) with copy buttons; key management.
- **Conversations:** transcript list, filters (`fallback`, `thumbs-down`), per-item
  **"Add answer to knowledge"** action (creates a text source).
- **Insights:** conversations/day, resolution rate (1 − fallback rate), top
  questions (MVP: most recent fallback questions; clustering later), and the
  monthly **customer voice digest** (§4.6).
- **Usage:** month-to-date metrics vs plan limits.

### 4.5 API surface (v1)

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /v1/core/tenants` | Cognito | Create workspace (signup flow) |
| `GET /v1/core/me` | Cognito | User + tenant + entitlements |
| `POST /v1/core/keys` / `GET` / `DELETE` | Cognito owner | API key management |
| `POST /v1/core/modules/{id}/enable` | Cognito owner | Flip entitlement |
| `GET /v1/core/usage` | Cognito / secret key | Usage month-to-date |
| `POST /v1/assistant/sources` (+ presign) | Cognito | Add knowledge source |
| `GET /v1/assistant/sources` | Cognito | List + statuses |
| `DELETE /v1/assistant/sources/{id}` | Cognito | Remove source |
| `PUT /v1/assistant/config` / `GET` | Cognito | Bot behavior |
| `POST /v1/assistant/chat` | any key/JWT (scope `chat:invoke`) | The product |
| `POST /v1/assistant/feedback` | same | 👍/👎 on a message |
| `GET /v1/assistant/conversations` | Cognito | Transcripts |
| `GET /v1/assistant/insights/digest` | Cognito | Customer voice digest (§4.6) |

### 4.6 Customer voice digest (Insights feature)

A monthly, AI-clustered summary of what customers actually said. This is a
**feature of Insights, free on every plan** — no entitlement, no separate
price. It shares other modules' data and surfaces, which is the
module-vs-feature test. Rationale: the job Canny-style feedback tools sell to
SaaS product teams, reshaped for SMBs — "what are customers asking, what
couldn't the bot answer, what changed since last month" (see
docs/market-research.md, 2026-08).

- **Inputs (grow as modules ship):** assistant conversations — fallback
  questions, thumbs-down exchanges, question themes. Once the Reviews module
  ships (§5): review text and private feedback. Later modules add their own
  signals.
- **Pipeline:** monthly EventBridge Scheduler rule → digest Lambda → pull the
  month's tenant-scoped records → one batched Bedrock call per tenant
  (cheapest adequate Claude tier) for clustering + summarisation → store in
  `Digests` table (PK `tenantId`, SK `yyyy-mm`).
- **Digest contents:** 3-7 themes, each with a label, count, trend vs. prior
  month, 2-3 verbatim examples, and a suggested action — fallback themes
  deep-link to the existing "Add answer to knowledge" flow.
- **Cost guardrails:** tenants under an activity floor (fewer than 20
  conversations and no reviews that month) get a counts-only digest with no
  model call; input tokens capped per tenant per run. Emits metering event
  `assistant.digest.generated` (standard usage envelope).
- **Surface:** Insights screen shows the latest digest plus history;
  `GET /v1/assistant/insights/digest?month=yyyy-mm`. Email delivery deferred
  until SES ships (same trigger as escalation/lead-capture).
- **Privacy:** derived only from the tenant's own data; the standard tenant
  isolation tests apply to `Digests` like any other table.

---

## 5. Reviews module (SHIPPED - as-built notes)

Shipped 2026-08-24. The sections below were the planning scope; where the
built module differs, the build is deliberate and listed here:

- **Ask page** lives at `chat.makerbay.app/review?slug=&token=`, on the
  existing pages surface, not a new `reviews.makerbay.app` subdomain.
- **Statuses** are `invited → published` (auto-publish on respond) with an
  owner `hidden` toggle - moderation is hide/show, never edit. The planned
  queued/reminded pipeline collapsed to a single ask with **no reminder in
  v1**; the manifest's "one reminder, then stop" remains the ceiling when a
  reminder is added.
- **Trigger** is the `booking.completed` EventBridge event (source
  `makerbay.booking`). If Reviews is enabled with autoAsk, a first-party
  invite goes out; otherwise the Get found Google-link ask runs. One ask per
  completion, never both. Accepted-quote triggering is future work.
- **Wall**: published reviews render on the tenant's Presence page (visible
  words only - no self-serving review structured data) and via
  `GET /v1/public/reviews`. The embeddable one-line snippet wall is future.
- **No gating** is enforced in code: every respondent gets the Google link
  after submitting, whatever the rating.
- Tables: `makerbay-reviews` (tenantId, reviewId), `makerbay-reviewsconfig`.
  Free-tier-style limit inside the paid module: 20 invites/month via
  MODULE_CATALOG limits.

## 5-planned. Original planning scope (historical)

Roadmap order 5, after Bookings and Quotes, because it needs a completed job
or appointment to trigger from (`modules/reviews/module.json`, which is the
source of truth where this section and the manifest differ). Depends on
Contacts like every non-core module: review asks create or update contact
records, never a side list. Delivery is email (SES) — SMS/WhatsApp rails went
away when the messaging module was dropped from the portfolio.

**Positioning:** $20-30/month flat vs. Podium/Birdeye at $300-600/month per
location. Month-to-month, white-label, no contracts — the incumbents' loudest
complaint clusters are annual contracts, per-location fees, and cancellation
traps.

### 5.1 Review requests

- Triggered by real events, not an arbitrary schedule: completed-booking and
  accepted-quote events on the `makerbay` bus create an ask for that contact.
  Manual send (dashboard button / `POST /v1/reviews/requests`) also available.
- Delivery: email via SES. **One reminder, then stop** — nagging costs the
  review and the customer (manifest behavior).
- Hosted ask page at `reviews.makerbay.app/{slug}`: tenant branding, star
  prompt, then the Google review link **and** a private-feedback box shown to
  every respondent. No rating gating (routing only happy customers to Google
  violates Google review policy); private feedback is captured alongside the
  public option, never instead of it. This is also a public commitment in the
  module FAQ.
- `ReviewRequests` table: requestId, tenantId, contactId, status
  (`queued` → `sent` → `reminded` → `clicked` → `completed`), sentAt.
- Free plan limit: 20 requests/month. Metering metric `review.requested`
  (metric names per the manifest's `meteredMetrics`; standard envelope).

### 5.2 Review wall, monitoring & AI replies

- **Review wall (launch scope, in the manifest):** an embeddable wall of
  collected reviews using the same one-line snippet as the assistant; a
  review going live on the wall meters `review.published`.
- **Google Business Profile monitoring + AI reply drafting (later stage, not
  yet in the manifest):** per-tenant Google OAuth; `Reviews` table (reviewId,
  tenantId, source, rating, author, text, postedAt, replyStatus, draftReply);
  drafts reuse the assistant's Bedrock pipeline and the tenant's persona/tone
  config, and the owner approves every reply (first cut: copy to clipboard;
  auto-post via the Google API later). Promote into the manifest only if
  first-party asks + the wall prove insufficient on their own.

### 5.3 API surface (v1)

Manifest routes: `/v1/reviews/*` (authenticated) and `/v1/public/reviews/*`
(ask page + wall).

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /v1/reviews/requests` | Cognito / secret key | Send review request |
| `GET /v1/reviews/requests` | Cognito | List requests + statuses |
| `GET /v1/reviews` | Cognito | Collected (and later monitored) reviews |
| `PUT /v1/reviews/config` / `GET` | Cognito | Template, send delay, reminder, ask-page + wall settings |
| `GET /v1/public/reviews/{slug}` | publishable key | Ask page + review wall data |

`POST /v1/reviews/{id}/reply-draft` arrives with the §5.2 monitoring stage.

### 5.4 Acceptance sketch

A completed booking emits its event → review ask email goes out (one
reminder max) → customer lands on the hosted ask page → review captured and
published to the wall, Google link offered → the ask and outcome appear on
the contact's history in Contacts → usage events land in the `Usage` table →
tenant isolation holds.

---

## 6. Milestones & acceptance criteria

**M0 — Skeleton (first deploy).** CDK stack: DNS + cert, Cognito, HTTP API +
authorizer, DynamoDB tables, EventBridge, empty module Lambda. ✅ *Accept:*
signup → login → `GET /v1/core/me` returns tenant with entitlements from a
deployed URL.

**M1 — RAG loop.** Sources upload → KB ingestion → `POST /v1/assistant/chat`
answers from uploaded doc with citations (non-streaming OK). ✅ *Accept:* upload
a PDF, ask a question only answerable from it, get correct cited answer; usage
events visible in `Usage` table.

**M2 — Dashboard + playground.** React app deployed at `app.makerbay.app` with
Knowledge, Behavior, Playground, Deploy screens; streaming on. ✅ *Accept:* the
10-minute onboarding (signup → docs → configured bot → playground answer) works
without touching AWS console.

**M3 — Widget + hosted page.** Publishable keys, iframe widget, `chat.makerbay.app/{slug}`.
✅ *Accept:* snippet pasted into a plain test HTML page yields a working branded
bot; publishable key cannot call any non-chat endpoint.

**M4 — Operate loop.** Conversations, feedback, "add answer to knowledge",
Insights, Usage screens, free-plan limits enforced. ✅ *Accept:* a thumbs-down
question converted to knowledge changes the bot's next answer; 201st message on
free plan politely refuses.

**M5 — Commercial surface.** ✅ Stripe billing with metered overage, staff
console at admin.makerbay.app with MFA and an append-only audit log, grants so
entitlements can be given without payment, public roadmap and changelog
generated from the module manifests. *Accept:* a subscription created in Stripe
changes the workspace's entitlement without touching a manual comp.

**M6 — Contacts + assistant depth.** ✅ Contacts as core substrate with
dedupe-on-upsert, an append-only per-contact timeline, CSV import and export;
a public, server-rendered help centre at help.makerbay.app/{slug}; citations
that carry the passage the answer came from. *Accept:* importing a CSV twice
creates each person once; a published source appears as an indexable article
with a canonical URL and a sitemap entry.

**M7 — Requests (next).** Handoff from the assistant, lead capture and
feedback, all inside the existing widget rather than a second one. Every
request creates or updates a Contact and appends to its timeline. Needs SES
production access. *Accept:* a question the assistant cannot answer becomes a
captured request, an email to the owner, and a contact with history.

---

## 7. Testing plan

- **Typecheck (in place):** `npm run typecheck` covers every Lambda and shared
  package. CDK bundles Lambda code with esbuild, which does **not** typecheck,
  so without this a type error ships and is only found at runtime. It has
  already caught one.
- **Unit (not yet built):** shared packages (auth, tenancy guard, metering
  client, contact dedupe, CSV parsing, the SSRF guard) — Vitest.
- **Integration:** against the deployed dev stack (single environment for now) —
  scripted API flows per milestone acceptance criteria, run from repo CI.
- **Tenant isolation test (must-pass, every milestone):** tenant B's key can
  never read tenant A's sources, conversations, or KB results. Automated.
- **Cost check:** after each milestone, Cost Explorer actuals reviewed against
  the $80 budget; any service trending >$10/mo gets flagged.
- **Manual E2E:** the 10-minute onboarding run before calling a milestone done.

---

## 8. Open items (need from founder)

Resolved: GitHub repo, domain registration, Bedrock model access, sample
knowledge documents, Stripe keys (test and live).

1. **SES production access** — the account is in the sandbox, so it can only
   send to verified addresses and is capped at 200 messages a day. Requests
   cannot ship without this. Raise the support request in the SES console;
   it is reviewed by a person, so allow a day or two. The staff console has a
   test-send that confirms when it lands.
2. **Live Stripe subscription, end to end** — the webhook endpoint and its
   events are registered, and the handler is proven in test mode, but no live
   subscription has ever been created. Worth doing once with a real card and
   refunding. Billing shows when the last Stripe event arrived and in which
   mode.
3. **Google Business Profile API access** — the Reviews module's monitoring
   stage (§5.2) needs a Google Cloud project approved for the Business
   Profile API plus per-tenant OAuth; Google's approval lead time is unknown,
   so kick this off when Reviews (roadmap order 5) is scheduled.
