# Spec: Genie - conversational admin for owners

Status: **APPROVED 2026-08-24; build underway.** Step 1 (audit log: table,
recordAudit helper, bus writer, dashboard Activity feed) SHIPPED in platform
1.15.0. Genie message allowances decided: Free 25/mo, Trade 250/mo, Genie
tier 2,500/mo - hard stop with an upgrade prompt, no surprise overage. Designed 2026-08-24 with a second Fable 5
architect pressure-testing the approach against the repo.

## What it is

A conversational interface for the BUSINESS OWNER (not their customers), sold
as the top tier (~$99/mo): from a mobile-first chat, view and operate
everything the dashboard can - what happened today, respond to requests and
reviews, manage bookings, create and send quotes/invoices, check payments,
adjust settings. Paired with a platform-wide AUDIT LOG so "what happened on
my site" is always answerable - by the dashboard and by Genie itself.

## Decisions (agreed in design review)

1. **The tool registry and the audit log are the product; the chat is a
   client.** Both improve the existing MCP server and dashboard even if the
   $99 price point misses.

2. **Tool layer: promote the MCP server's `McpTool` registry into
   packages/core.** Each module ships its own tools file (assistant already
   does). One definition serves mcp.makerbay.app, Genie, and future API docs -
   never a second description of a module. Extend with
   `risk: 'read' | 'reversible' | 'confirm'` and a `preview()` returning a
   structured what-will-change object. Tool coverage declared in module.json
   so Genie says honestly what it cannot do yet.

3. **Model: Bedrock Converse, Sonnet-tier for the agent loop** (Haiku only
   for cheap classification - never for writes), prompt caching on tool
   definitions. Cost bound with `genie.tokens` metering through the standard
   usage envelope, hard caps (tool-calls-per-turn ~8, turns/day), polite stop
   at the limit. Streaming via the existing stream.makerbay.app path with
   status lines during tool calls.

4. **Write safety - the lethal-trifecta controls:**
   - Server-side PendingAction rows: Genie proposes; the chat renders a
     confirmation card FROM THE SERVER-HELD PREVIEW (never model prose);
     Confirm applies the stored args. Single-use, idempotent, 10-min expiry.
   - Risk tiers: reads auto; reversible actions auto with an undo chip;
     anything leaving the tenant (send quote/reply), anything public
     (page edits), anything money, always a confirmation card.
   - Injection defence: customer-supplied text is wrapped as untrusted data;
     **taint escalation** - once a turn reads untrusted content, every write
     that turn requires confirmation regardless of tier; human confirm is the
     real backstop; Genie's runtime credential carries only registered tools.

5. **Audit log:** table `makerbay-audit`, PK `tenantId#yyyy-mm`, SK
   `ts#ulid`; item = actor {user|apikey|genie|system}, origin, action
   (`quotes.sent`), target, one-sentence summary, small diff for config
   writes (no full snapshots). Write path: `recordAudit()` core helper emits
   detail-type `audit` on the existing bus; one rule → one writer Lambda.
   The writer also subscribes to existing domain events so system actions
   are captured for free. TTL retention: 90 days free, 13 months on Genie
   tier. Dashboard gets an Activity feed; Genie gets a `query_activity` read
   tool (powers "what changed yesterday?" and the morning briefing). Genie's
   own applied actions record dual attribution (genie + confirming user).
   The staff console's append-only admin log stays the compliance record.

6. **Surface: dashboard chat page, mobile web, v1 only.** WhatsApp/SMS
   deferred - a "reply YES" confirm over SMS to an LLM with write powers is
   unsafe; revisit WhatsApp read-only (briefings + deep links) as phase 2.
   Memory: persistent sessions (Conversations-shaped table) plus a rolling
   per-tenant preference summary; no vector memory - the audit log and module
   data ARE the memory of what happened.

7. **Packaging: Genie is a module** (`entitlementKey: 'genie'`); $99 is a
   bundle price writing grants for genie + Bookings + Reviews + Presence Pro,
   with a generous `genieTokensPerMonth` in the grant. Zero new entitlement
   mechanics; gate on the entitlement, never a plan name.

## V1 scope

Ship: morning briefing; read tools across all live modules; write tools for
the top five owner actions (reply to request, draft+send review reply,
create/reschedule/cancel booking, create+send quote, mark invoice paid);
audit table + dashboard Activity feed + query_activity; confirmation-card
flow; metering + caps.

Defer: page editing via chat, settings/API-key management, WhatsApp/SMS,
autonomous multi-step jobs ("chase all unpaid invoices"), voice, scheduled
proactive messages, vector memory.

## Named risks and mitigations

- Latency (8-20s multi-tool turns): streamed status lines, parallel calls,
  precomputed daily briefing, prompt caching.
- "Said it did it but didn't": receipt cards rendered from server tool
  results + audit entries, never from model text; audit log is the arbiter.
- Partial multi-step failure: every write is an individually confirmed,
  idempotent action - a composite request becomes a checklist of cards.
- Coverage drift: manifest-declared tool lists keep "everything the UI can
  do" honest.

## Build order (after approval)

1. Audit log (helper + writer + Activity feed) - standalone value, ships first.
2. Tool registry promotion to core + registry entries for live modules.
3. Genie Lambda (Converse loop + pending actions + metering) + chat page.
4. Stripe product + $99 bundle grants.
