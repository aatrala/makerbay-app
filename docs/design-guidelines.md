# MakerBay design guidelines

Every module inherits this. A new module should not invent colours, spacing,
or component shapes — if something is missing here, add it here first.

## Who we are designing for

A small-business owner, not a developer. They log in weekly, not hourly. They
are deciding whether to trust software with their customers' first impression.

Three consequences:

1. **Precision over density.** Show real information densely — tables, usage,
   conversations. Give breathing room wherever someone is deciding or learning.
2. **Plain language everywhere.** No `tenant`, `entitlement`, `ingestion`, or
   `fallback` in the interface. Say workspace, plan, processing, "when it
   doesn't know".
3. **Never leave someone stuck.** Every empty state says what to do next.
   Every error says what happened and how to fix it.

## Tokens

The whole visual identity lives in one `:root` block. Swapping the accent ramp
changes the product; nothing else should hardcode a colour.

```css
--ink:        #1c1917;   /* headings, primary text */
--body:       #57534e;   /* body copy */
--muted:      #a8a29e;   /* meta, timestamps, placeholders */
--line:       #e7e5e4;   /* borders, dividers */
--surface:    #ffffff;   /* cards */
--bg:         #faf9f7;   /* page background — warm, never pure grey */
--sidebar:    #1c1917;   /* dashboard chrome */

--accent:     #c2410c;   /* primary actions */
--accent-dim: #9a3412;   /* hover */
--accent-sub: #fff7ed;   /* tinted backgrounds */

--ok:         #15803d;   /* ready, healthy, live */
--warn:       #b45309;   /* processing, attention */
--err:        #b91c1c;   /* failed, destructive */
```

**Why the accent is warm, not green or blue.** Green already carries meaning in
this product — ready, healthy, resolved, live billing. If the brand is also
green, status stops being legible. Blue is what every competitor uses. Warm
orange stays out of the way of our own semantics.

### Type

One family (system stack), one scale, three weights.

| Role | Size | Weight |
|---|---|---|
| Page title | 22px | 650 |
| Section title | 17px | 650 |
| Card title | 15px | 600 |
| Body | 15px | 400 |
| Meta / help | 13px | 400 |

Line height 1.5 for body, 1.25 for headings. Never below 13px — SMB owners are
not all twenty-five.

### Space and shape

A 4px scale: `4 8 12 16 24 32 48`. Radius: `6px` controls, `10px` cards,
`20px` pills. One border style: `1px solid var(--line)`.

**No shadows, no gradients.** Depth comes from borders and background steps.
Shadows are reserved for things that genuinely float — modals, dropdowns.

### Density

The one place dashboard and marketing differ.

| | Dashboard | Marketing |
|---|---|---|
| Section padding | 20px | 72px |
| Card padding | 16–20px | 24px |
| Max width | 980px | 1080px |
| Body size | 15px | 17px |

## Components

**Buttons.** One primary per view — the thing you want them to do. Everything
else is `ghost` (bordered) or a plain link. Destructive actions are text-red
with a border, never a solid red block; solid red reads as "primary" to
someone scanning.

**Cards** group one idea and carry one heading. If a card needs two headings,
it is two cards.

**Tables** are for scanning: left-align text, right-align numbers, keep row
actions in the last column, and never rely on hover to reveal an action — that
is invisible on touch.

**Status chips** use the semantic ramp only: ready is `--ok`, processing is
`--warn`, failed is `--err`, neutral is `--muted`. Never brand-coloured.

**Forms.** Label above the field, always. Help text below in `--muted`. Errors
below the field in `--err`, naming the fix. Never placeholder-as-label.

**Empty states** are a heading, one sentence, and one button. They are the most
important screen a new customer sees, and the easiest to forget to design.

**Loading.** Skeletons that match the shape of the content, not spinners.
A screen must never flash between blank and full.

**Destructive confirmation.** Anything irreversible states what will be lost
and requires a deliberate action, not a reflexive "OK".

## Writing

- Sentence case for everything, including buttons and headings.
- Say what a thing does, not what it is called: "Add a page from your website",
  not "URL ingestion".
- Numbers get units and context: "11 of 200 messages", not "11".
- Dates are readable — "23 Aug 2026, 4:15 pm" — never raw ISO strings.
- Errors follow: what happened, why, what to do.

## Accessibility

Not optional, and cheap if done from the start.

- Text contrast at least 4.5:1; large text and UI borders at least 3:1.
- Every interactive element has a visible focus ring — never `outline: none`
  without a replacement.
- Touch targets at least 44×44px.
- Colour never carries meaning alone: pair every status colour with a word.
- Respect `prefers-reduced-motion`; keep transitions under 200ms regardless.

## Responsive

Three widths: phone (<640px), tablet (<960px), desktop. The dashboard sidebar
collapses to a top bar on phones, tables scroll horizontally inside their card
rather than breaking the page, and no view may scroll horizontally as a whole.

## How a module inherits this

A new module adds screens that use these tokens and components, and it must
not ship its own colour, its own button, or its own card. Module-specific
visual identity belongs in one place only: the module's icon and its marketing
page accent imagery.
