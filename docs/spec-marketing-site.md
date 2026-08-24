# Marketing site — specification

**Version:** 1.0 · **Date:** 2026-08-24 · **Lives at:** makerbay.app
**Built by:** `site/build.mjs` · **Theme:** `docs/design-guidelines.md`

---

## 1. What the site is for

One job: get a small business owner from "what is this" to a workspace with
their own documents in it, in about ten minutes. Everything else is secondary.

The reader is a salon owner, an electrician, a clinic manager. Not an engineer.
That decides the tone (plain, specific, no jargon), the density (marketing
spacing, not dashboard density), and what goes above the fold (what it does for
them, not how it is built).

## 2. Information architecture

```
/                      Home — what it is, the modules, how it works, pricing, FAQ
/pricing               What is free, what is paid, and what a module costs
/modules/<id>          One page per module, generated from its manifest
/roadmap               What is live, next, and explicitly not being built
/changelog             Every customer-visible change, filterable by area
/404
```

Every page except `/` and `/404` is generated. A hand-written page at
`src/modules/<id>/index.html` wins over the generated one, which is how the
assistant keeps its longer story.

## 3. What is generated, and from what

| Page or block | Source |
|---|---|
| Module grid on `/` | every `modules/*/module.json` |
| `/modules/<id>` | that module's `marketing` block |
| Free vs paid split | each manifest's `pricing` field |
| `/pricing` module table | `pricing`, `freeLimits`, `status` |
| `/roadmap` order and notes | `roadmap.order`, `roadmap.note` |
| `/changelog` | `CHANGELOG.md` |
| `sitemap.xml` | the generated page list |

**A module is described in exactly one place.** If a fact about a module
appears in two files, one of them will eventually be wrong, and it will be the
one on the marketing site.

### Build-time guards

The build **fails** rather than publishing something misleading:

- a changelog release that parses with no entries (this happened: git checks
  the file out with CRLF on Windows and `.` in a JS regex does not match `\r`,
  so every entry silently failed to parse while the headings still matched);
- an unknown changelog area or kind;
- a module manifest missing its `marketing` block or `pricing`.

## 4. Pricing presentation

The pricing model is **free platform, paid capability**:

- **Free forever:** Contacts, Requests, Quotes, and the help centre. These cost
  us close to nothing per use, and each one makes the paid modules more
  valuable by filling Contacts with real customers.
- **Paid:** Assistant (real Bedrock cost per message) and Bookings.

The site must say which is which on every surface where a module appears: the
grid card, the module page hero, the roadmap, and the pricing table. A customer
should never have to guess whether the thing they just read about costs money.

Free is stated as **free**, not "free tier" or "freemium". Caps exist to bound
our cost and are printed plainly; they are not an upgrade prompt.

## 5. Theme

Inherits `docs/design-guidelines.md` exactly — the same tokens as the
dashboard, differing only in density:

| | Dashboard | Marketing |
|---|---|---|
| Base size | 15px | 17px |
| Section rhythm | 16px card gaps | 72px section padding |
| Measure | up to 980px | 1080px wrap, 62–74ch for prose |
| Accent | `--accent` #c2410c on controls | same, plus warm dark heroes |

Rules that are not negotiable, because they are what makes the product feel
like one thing:

- **Green means shipped.** `--ok` is reserved for live status and nothing else.
  It is why the brand accent is warm rather than green.
- **Dark surfaces are warm** (`#1c1917` → `#33251c`), never blue-black.
- **Focus is always visible**, and on dark surfaces it switches to `#fdba74`
  so it stays visible there too.
- **One `<h1>` per page**, matching the `<title>` and the canonical URL.

## 6. Every page carries

- a `<title>` under 60 characters and a `description` under 155;
- `og:title`, `og:description`, `og:url`, `og:type`;
- a `<link rel="canonical">` to the absolute URL;
- the shared header and footer, so navigation never disappears;
- `noindex` when the page is genuinely thin (an empty help centre, a 404).

## 7. Accessibility

Not a section of its own in the design guidelines by accident — it is a
property of every rule above:

- text at 4.5:1 against its background, checked on the dark hero too;
- link cards are a single `<a>` so the whole card is one tab stop, not four;
- the changelog filter is `<button>`s with `aria-pressed`, and the entries are
  all in the page — filtering only hides them, so it works before JavaScript
  runs and the back button behaves;
- `prefers-reduced-motion` disables the smooth scroll and the card lift.

## 8. Acceptance

- Every route returns 200; a nonsense path returns 404.
- The changelog shows every entry in `CHANGELOG.md`, and filtering by area
  hides releases that have nothing in that area.
- The homepage grid, `/pricing` and `/roadmap` all name the same set of
  modules with the same statuses — because they read the same files.
- No horizontal scroll at 375px on any page.
- Marking a module free in its manifest changes the grid, its page, the
  roadmap and the pricing table with no other edit.
