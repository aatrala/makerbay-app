# MakerBay — Platform Core + Assistant Module Specification

**Version:** 0.1 (draft for build)
**Date:** 2026-08-23
**Domain:** makerbay.app
**AWS account:** 953146692138 · profile `makerbay` · region `us-east-1`
**Budget guardrail:** $80/month AWS budget with alerts (already live)

---

## 1. What we are building

MakerBay is a modular B2B SaaS platform for SMBs. Businesses subscribe to a base
plan and enable capability **modules** (AI assistant, booking, dashboards,
messaging bots, compliance) as plugins. Every module is API-first: usable from
the MakerBay dashboard, via REST API with tenant API keys, and later via MCP.

**This spec covers two things:**

1. **Platform core (thin):** tenancy, auth, entitlements, API keys, usage metering.
2. **Module 1 — Assistant:** a RAG chatbot an SMB trains on its own documents and
   deploys as an embeddable widget, a hosted chat page, or an API.

### Goals

- A live, end-to-end product: SMB signs up → uploads docs → tests bot → embeds widget.
- Every platform seam (tenancy, entitlements, metering) exercised for real by module 1.
- Total AWS cost at zero/low traffic: under $15/month.

### Non-goals (deferred, with triggers)

- Stripe billing integration — stub entitlements manually until first paying customer.
- MCP server — the week after the assistant API stabilizes.
- Additional modules — after assistant ships.
- Custom domain email (SES) — when escalation/lead-capture ships.
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
  questions (MVP: most recent fallback questions; clustering later).
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

---

## 5. Milestones & acceptance criteria

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

---

## 6. Testing plan

- **Unit:** shared packages (auth, tenancy guard, metering client) — Vitest.
- **Integration:** against the deployed dev stack (single environment for now) —
  scripted API flows per milestone acceptance criteria, run from repo CI.
- **Tenant isolation test (must-pass, every milestone):** tenant B's key can
  never read tenant A's sources, conversations, or KB results. Automated.
- **Cost check:** after each milestone, Cost Explorer actuals reviewed against
  the $80 budget; any service trending >$10/mo gets flagged.
- **Manual E2E:** the 10-minute onboarding run before calling a milestone done.

---

## 7. Open items (need from founder)

1. **GitHub repo** — URL + collaborator access (or empty repo; scaffold pushed).
2. **Domain contact details** — for makerbay.app registration (see chat).
3. **Bedrock model access** — will verify in-account; may need a one-click
   console approval for Anthropic models.
4. **Sample knowledge docs** — 2–3 real PDFs/FAQs make demos meaningful;
   fixtures used otherwise.
5. **Stripe** — not needed until post-M4.
