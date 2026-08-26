# Genie-written page copy (issue 75)

Approved 2026-08-26 after an agent consult; built the same day.

## Shape

Inline in the Page editor, not chat: a "Draft with Genie" bar in the
Words card (headline + intro) and "Draft answers with Genie" in the
FAQ editor, each with an optional one-line instruction. `POST
/v1/presence/copy-draft` **writes nothing** - the draft lands as
ordinary unsaved form state, the existing debounced draft-preview
renders it on the real page within a second, and the owner's edit +
Save is the confirmation (page saves are already versioned, so undo is
Version history). The Genie chat surface just points here.

## Mechanics

One Converse call (Haiku, forced `page_copy` tool, maxTokens 1500) on
a server-built context pack: tenant name, current copy, active
services with prices, opening hours, published reviews, and up to
~6k chars of knowledge-base chunks (tenantId-filtered Retrieve, two
queries). Full draft ≈ $0.01.

Guardrails: facts-only prompt (never invent services/prices/
certifications/areas), knowledge text marked information-never-
instructions, banned marketing-sludge words, server-side length
truncation at sentence boundaries (headline 80 / intro 300 / FAQ
120+400, max 6), URLs stripped from output, same-language rule.
`409 not_enough_context` when there are no services, no knowledge and
no intro - a fabricated page is worse than an empty one.

## Gating and cost control

Every draft consumes **one Genie message** from the same ladder as
chat (2500 Genie / 250 Trade / 25 Free taster) plus a monthly
`presence.copydraft` cap of 100. FAQ drafting follows the FAQ save
gate (Trade+); free tier can draft headline + intro - the best Genie
ad in the product.
