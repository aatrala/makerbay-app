# Spec: Page styles, blocks, FAQ, sub-pages, theming (issue 45)

Status: **APPROVED 2026-08-25** (founder: variants shown, tier ladder
confirmed). This document is the build contract.

## The one-line ladder

**Free looks good · Trade is arranged your way · Genie is fully branded.**

## Styles

Three selectable layouts. Content is style-independent; switching styles
never loses anything.

- **Simple** (free, default) - today's single page, all blocks inline.
- **Grow** (Trade) - one page where big blocks render a preview (first 3
  services / 2 FAQs / 2 reviews) with "See all" linking to a real
  sub-page once content exceeds the preview.
- **Storefront** (Trade) - a small site: nav (Home / Services / FAQ /
  Reviews as present), condensed hero, every big block as its own page.

Sub-pages are real URLs: `makerbay.app/p/{slug}/faq` and, on a custom
domain, `yourbusiness.com/faq`. Each carries its own title, canonical and
(FAQ) FAQPage JSON-LD, following the page's existing index/noindex rules.
On the Simple style, sub-page URLs 301 to the main page.

## Blocks

`blocks: [{ id, visible }]` in order; ids: `about, services, faq,
reviews, hours, contact`. Hero is always first and not a block. Default
order matches today's page. Show/hide: free (existing toggles stay
free). **Reorder: Trade.** The dashboard editor uses drag with arrow
buttons as fallback.

## FAQ (Trade)

Owner-written items `{ q, a }`, max 20, each ≤120/1200 chars. Rendered
as a `<details>` accordion (block) and the /faq sub-page. Separate from
the auto-generated help centre; a "From our help centre" list may link
published articles under the FAQ later (not in v1).

## Theming

- Accent colour: free (exists today, unchanged).
- **Palette (Trade)**: `palette: { paper, ink, button }` hex overrides
  laid over the chosen themeStyle tokens. Server-validated hex; the
  renderer computes a readable button foreground the same way the chat
  widget does.
- **Fonts (Genie)**: `fontPair` from a curated list (system, classic,
  modern, editorial, friendly) mapping to Google-font pairings loaded
  only when set. No arbitrary fonts - taste and speed are the product.

## Versioning (Trade)

Every PUT of page settings snapshots `{pageStyle, blocks, faq, palette,
fontPair, headline, intro, accentColor, themeStyle}` to the
PresenceVersions table (tenantId, sk = ISO#ulid). Keep the newest 20;
prune on write. Restore is one click and itself creates a snapshot.
Every save and restore lands on the workspace activity trail.

## Tier resolution (server-side, never client)

`pageTier(tenantId)`: 'genie' when a live genie grant/subscription
(taster does not count) → else 'pro' when the presence grants resolve to
pro (same gate as custom domains) → else 'free'. Requests carrying
capabilities above the caller's tier are refused with a 402 naming the
tier, and the UI shows locked options with TRADE/GENIE chips + preview -
locked options are visible on purpose; the settings page is the upsell.

## API

- `GET /v1/presence/page` → `{ page, tier }` (page = style/blocks/faq/
  palette/fontPair + defaults filled)
- `PUT /v1/presence/page` → validated, tier-gated save + snapshot
- `GET /v1/presence/versions` → newest-first list (pro)
- `POST /v1/presence/versions/restore { sk }` (pro)
- Public: `/v1/public/presence?slug=&sub=faq|services|reviews` (the
  /p/{slug}/{sub} CloudFront function forwards the sub segment; the
  custom-domain function forwards the path).

## Not in v1 (parked)

Per-service pages (needs service slugs), gallery block, help-centre
article embedding on the page, Genie-written page copy (the future
Genie-tier hook), true drag on touch devices (arrows work everywhere).
