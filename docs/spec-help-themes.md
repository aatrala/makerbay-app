# Help centre v2: themes, article formatting, structure (issues 64-67)

Approved 2026-08-25 after a two-agent consult (survey of Intercom, Help
Scout, Notion, Zendesk Guide, Apple, Linear, GitBook patterns + a design
critique of round-one mockups). Sample page: the "MakerBay Help Themes"
artifact. Founder approved the lineup and the tier packaging.

## Tier ladder

- **Free** - Clean theme (brand top-bar), all shared improvements,
  "powered by MakerBay" badge, source cap 20.
- **Trade** (paid workspace) - four more themes (Bold, Editorial,
  Ledger, Signwriter), pin popular articles, reorder categories,
  source cap 60.
- **Genie** (genie grant) - full branding: heading font, second accent,
  logo in the header (the page photo), no MakerBay badge, source cap
  150. Custom domains ride the existing Genie domain support (later).

`helpTier(tenantId)`: genie grant live -> genie; `isPaidWorkspace` ->
trade; else free. Source cap = `max(limits.sources, tier cap)` so a
grant with bigger explicit limits still wins.

## Shared improvements (every tier, one renderer)

- "Popular" strip above categories: owner-pinned sourceIds (Trade), or
  the 4 most recently updated articles when nothing is pinned.
- Article counts on category headings.
- "Still stuck?" escalation block with the business phone and email
  (from the presence config) on index and article pages.
- Related articles (same category, up to 3) at article end.
- "Was this helpful? Yes/No" - POSTs to
  `/v1/public/assistant/helpful` (CORS is open on api.), increments
  `helpfulYes`/`helpfulNo` on the source row. Insights can surface it.
- Breadcrumb (Help centre -> Category -> Article) + `BreadcrumbList`
  and `Article` JSON-LD with dateModified.
- Read time next to Updated.
- Hover states on all clickable rows; AA contrast on secondary text.

## Formatted articles

At first publish (or `regenerate: true`) one extra model call
(`generateHelpBody`) turns the extracted text into markdown-lite:
`##` headings (numbered steps allowed), paragraphs, `-` bullets,
`**bold**`, and `Tip:`/`Note:`/`Warning:` lines. Stored in S3 at
`{s3Key}.help.md`, key on the row as `helpBodyKey`. The renderer
escapes then converts: numbered `##` headings render as brand-circle
step numerals, Tip/Note/Warning paragraphs as callouts. Fallback when
absent: today's pre-wrap text. Publishing never fails on it.

## Themes

`helpTheme` on the assistant config: `clean | bold | editorial |
ledger | signwriter` (default clean; non-clean needs Trade). One
renderer, per-theme CSS + small structural switches:

- **clean** - current look + 3px brand top-bar on the header.
- **bold** - dark-brand header, full-bleed brand hero, search bar
  overlapping the hero edge, card grid. Header/hero darks derived from
  the brand colour, sentence case everywhere except category chips.
- **editorial** - Source Serif 4 + Source Sans 3, ruled list index (no
  cards), outlined-pill Ask button, lede paragraph on articles.
- **ledger** - IBM Plex Sans/Mono, white ground, category sidebar
  (chip row on phones), ruled rows with mono dates, "In brief" summary
  strip on articles.
- **signwriter** - Zilla Slab + Public Sans, brand-colour category
  bands, numbered article rows, dark contact board with phone/hours.

Genie fields on config: `helpFontHead` (Google font family, sanitised,
loaded via fonts.googleapis.com), `helpAccent2` (#hex), `helpShowLogo`
(presence photo in the header). Badge suppressed automatically at
genie tier.

Trade fields: `helpPinned` (sourceIds, max 4), `helpCategoryOrder`
(permutation of the category list).

## Caps + visibility

- Sources GET returns `{ sources, cap, used }`; the Help centre and
  Knowledge pages show "19 of 20 sources" and warn when full (a crawl
  that hits the cap stops silently - the meter is the fix's first
  half; a crawl-truncation warning banner is the second).
- Config GET returns `{ config, helpTier, sourceCap, sourceCount }`.

## Out of scope for this build (queued separately)

- Native article authoring in the Help centre tab (64 proposal A) -
  still awaiting an explicit go.
- Images in articles, custom help domains, hours from booking
  availability, "was this helpful" analytics page.
