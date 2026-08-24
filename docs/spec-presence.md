# Presence — a page per business

**Version:** 1.0 (draft for build) · **Date:** 2026-08-24
**Module id:** `presence` · **Pricing:** free
**Depends on:** Contacts, Assistant, Bookings, Quotes (all shipped)
**Vision context:** `docs/vision.md` — this is item (c), and it is next.

---

## 1. What it is

Every workspace gets a real web page at `makerbay.app/p/{slug}` from the moment
it is created. Not a template to fill in — a page that already works, built
from what the workspace already has, that the owner then edits.

It is the thing a customer actually lands on. The assistant, the diary and the
price list are behind it; this is the front.

**The test it has to pass:** a tradie signs up, adds their website, and within
ten minutes has a page they would put on a van.

## 2. Why it comes first

Everything it needs is built. Services and hours are in Bookings. Knowledge and
the assistant are in Assistant. The customer record is in Contacts. Presence is
mostly assembly — and assembly is what turns five modules a customer has to
understand into one product they can be sold.

It is also the only one of the five that makes the other four visible.

## 3. Page anatomy

Ordered by what a customer wants, not by what we have:

1. **Who and what** — business name, one line, the services they do, the areas
   they cover.
2. **Book now** — the real diary. Not a contact form. This is the whole point.
3. **Ask anything** — the assistant, inline, answering from their documents.
4. **When they are open** — including "closed now, back at 8am", computed in
   the business timezone.
5. **How to reach a human** — phone, and later the voice agent.
6. **Proof** — reviews when Reviews ships; until then, nothing rather than
   filler.

### Free by default, and honest about it

The page is free forever. It renders whatever the workspace has: if Bookings is
off, the book-now block is a call-us block; if the assistant has no knowledge,
the ask block does not appear. **A page never shows a control that does
nothing.** An empty section is worse than a missing one.

## 4. Rendering

Server-rendered HTML, cached at CloudFront, exactly like the help centre and
for the same reason: it exists to be indexed, and a page that needs JavaScript
to show its content indexes badly.

- `GET /p/{slug}` → the page. A CloudFront function rewrites to
  `/v1/public/presence?slug=…`, cached 5 minutes at the edge.
- Booking and chat are progressive: the page is complete and readable without
  JavaScript; the widgets enhance it.
- `LocalBusiness` (or the closest subtype) JSON-LD with name, address if given,
  `areaServed`, `openingHoursSpecification` from the Bookings config, and
  `makesOffer` from the services. **Only from data the owner actually entered** —
  invented structured data is worse than none.

## 5. Editing

One screen in the dashboard. No page builder, no drag and drop — a tradie will
not use one and it would take a month to build.

```
PresenceConfig  (pk tenantId)
  headline          "Emergency electrician, Coimbatore"
  intro             two or three sentences
  serviceAreas[]    suburbs or towns, free text
  phone, email
  photoKey          one hero image in S3
  brandColor        inherited from the assistant config
  showBooking       default: on when Bookings is enabled
  showAssistant     default: on when there is knowledge
  published         default: true
  customDomain      later; out of scope for v1
```

Everything else is read from the modules that already own it. **Nothing about a
service, an opening hour or a price is stored twice.** Change your hours in
Bookings and the page changes.

## 6. API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /v1/public/presence` | slug | Render the page (HTML) |
| `GET /v1/public/presence/data` | slug or key | Same content as JSON, for the widget and for us |
| `GET /v1/presence/config` | Cognito | Read the editable bits |
| `PUT /v1/presence/config` | Cognito | Save them |
| `POST /v1/presence/photo` | Cognito | Presigned upload for the hero image |

## 7. Rules

- **The slug is the identity.** It already exists on the tenant and is already
  used by the hosted chat and the help centre. One slug, one business, three
  surfaces — never a second naming scheme.
- **Unpublished means 404**, not a placeholder. A half-finished page indexed by
  Google is a liability the owner cannot easily undo.
- **No invented content, and this is now a hard rule rather than taste.**
  Generating "Joe's Electrical provides reliable emergency electrical services
  in Newtown..." for every tenant from one prompt produces a near-duplicate
  corpus at scale, which is the single most likely way this domain gets
  classified as scaled content abuse - taking every other tenant's page down
  with it. Template the *structure*; fill it with data the owner entered.
  See `docs/analysis-search-visibility.md` section 3.

- **A page is `noindex` until it is genuinely complete.** Real photo, at least
  one priced service, a real intro. This keeps our index at roughly one page
  per real business rather than one per signup, which is the difference between
  a corpus Google trusts and one it discounts wholesale.

- **If the tradie already has a website, our page is `noindex, follow`** and
  links to theirs. We do not cross-domain canonical, and we do not compete with
  our own customer for their own brand name.

- **Churn is handled from day one.** Deleted tenant returns `410 Gone`. Lapsed
  but intact returns `noindex, follow` and stays live so it is reversible.
  Never `robots.txt`-block a page we want deindexed - Google cannot recrawl to
  see the `noindex`. Never bulk-redirect dead tenants to a category page; that
  is a soft-404 doorway pattern.

- **Sitemaps segmented by page type**, so Search Console tells us which class of
  page is being rejected instead of leaving us blind.
- **Photo is optional and one.** Not a gallery. A gallery is a project and an
  empty gallery looks abandoned.

## 8. What is not in v1

| Deferred | Why |
|---|---|
| **Receiving payments** | Money into the *tradie's* account needs Stripe Connect: onboarding, identity verification, payouts, liability. Scheduled as its own project, and it blocks this part of the vision rather than being dropped. |
| **Custom domains** | Certificate provisioning per tenant, and a support burden every time someone's DNS is wrong. Worth it later; not on the first page. |
| **Multiple pages per business** | One page that works beats five that are thin - which is also what the search-visibility analysis will care about. |
| **Themes** | One good design applied consistently. A theme picker is how a platform ends up with pages that look worse than the default. |

## 9. Acceptance

- A workspace created five minutes ago has a page at `/p/{slug}` that renders
  its real services and real free slots, with no configuration.
- Turning Bookings off replaces the booking block with a call-us block; no
  dead controls, no empty section.
- The page scores well on Core Web Vitals and contains valid `LocalBusiness`
  JSON-LD built only from entered data.
- Editing the headline changes the page within one cache period.
- Changing opening hours in Bookings changes the page — the hours are not
  stored twice.
- `?slug=` for a workspace that does not exist, or is unpublished, returns 404
  with a `noindex` page.
- No horizontal scroll at 375px; the page is legible without JavaScript.

## 10. Then what

Presence is now also where the search *value* lives, not just the search risk.
The visibility research concluded that a directory cannot rank without supply we
will not have for years, and that what actually works is being the best page a
tradie can point their Google Business Profile at. So the next features here are
GBP assist and review generation - not a directory.
It makes (e) Voice worth more, because the voice agent has somewhere to send
people. And it makes Stripe Connect urgent rather than theoretical.

The sequencing in `docs/vision.md` §7 holds: build this, then Connect, then
decide about Visibility with the analysis in hand.

---

## Addendum 2026-08-24: reviews on the page, custom domains (shipped)

### §10 Reviews section
Published first-party reviews (Reviews module enabled + published rows)
render in a "What customers say" section: average, count, latest five.
Visible words only - deliberately no review structured data, because review
markup about your own business on your own page is self-serving under
Google's guidelines and ignored at best.

### §11 Custom domains (Presence Pro)
- Gate: `getEffectiveEntitlement(tenantId, 'presence').planTier === 'pro'`,
  else 402. The free makerbay.app page is never affected.
- `PUT /v1/presence/domain {domain}` → ACM certificate (DNS validation) →
  owner adds the validation CNAME. `GET` polls: once ISSUED, the Lambda
  creates a per-tenant CloudFront distribution (origin api.makerbay.app,
  shared viewer-request function rewrites every path to
  `/v1/public/presence?domain={host}`, shared presence cache policy, the
  tenant's certificate). Owner then points their domain (CNAME) at the
  distribution. States: pending_validation → pending_dns → active.
- Host lookup: `byDomain` GSI on PresenceConfig.
- Canonicals: with an active custom domain, the custom domain is the
  canonical home and the free page points at it (same content, one address
  in the index). Without one, unchanged.
- `DELETE` disables the distribution best-effort and clears the config;
  a never-used certificate is deleted immediately.
