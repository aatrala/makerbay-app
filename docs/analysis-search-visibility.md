# Search visibility — hard assessment

**Version:** 1.0 · **Researched:** 2026-08-24 · **Feeds:** `docs/vision.md` item (d)
**Method:** live Google SERP probes on four representative queries, plus
Google's own spam and structured-data policy documentation.

---

## 1. Verdict

**(d) as originally imagined is a trap.** Not because local search does not
matter — it matters enormously — but because:

- the page we would build (`/p/joes-electrical`) is **the wrong page type** for
  the queries we would target, and
- the page type that *is* right (`/electricians/newtown`) is **exactly the shape
  Google's doorway and scaled-content policies target**, is held by entrenched
  incumbents, and cannot legitimately exist until we have supply density we will
  not have for years.

There is a real, smaller, honest version worth building. It is *"be the best
page a tradie can point their Google Business Profile at"*, not *"be a directory
that ranks"*.

## 2. The evidence that settles it

Live top-10 organic results, gathered 2026-08-24. Across 40 results for
`[service] [suburb]` queries, **exactly two** were single-provider pages hosted
on a third-party platform — one on a decade-old spammy UGC site, one almost
certainly ranking on the salon's own brand name.

`makerbay.app/p/joes-electrical` is that same page type.

> **The per-tradie page will not rank for `[service] [suburb]`. That is a
> page-type problem, not a tuning problem.** No amount of markup, speed or
> content fixes it.

What *does* rank is a suburb-level **list**: operator-owned suburb pages, and
incumbent directories. In Australia: Localsearch, Yellow Pages, hipages,
Airtasker, ServiceSeeking. In India: IndiaMART, JustDial and six regional
directories took **10 of 10** results.

One Yellow Pages URL ranking at #5 and #7 literally contains
`newtown-nsw-2042` repeated six times. A grotesque, broken URL outranks
technically perfect pages. **Domain authority and age are beating quality by a
wide margin, and a new domain has neither.**

### The one working analogue proves the rule

Fresha's suburb page ranks **#1** for salons. It ranks because it lists real,
bookable salons with real prices, photos and reviews — a database query with
genuine inventory behind it. Fresha serves ~130,000 businesses across 120
countries at ~$140M ARR.

**Our equivalent would render "1 electrician" for years.**

## 3. The risk that comes from (c), not (d)

This is the finding I did not expect and the most immediately actionable.

> If Presence auto-generates "Joe's Electrical provides reliable emergency
> electrical services in Newtown…" for every tenant from the same prompt, we
> produce a near-duplicate corpus at scale. **That is the single most likely way
> MakerBay gets classified as scaled content abuse — and it comes from the
> module we are building next, not from the directory we deferred.**

Google's spam policies name "scaled content abuse" (March 2024) and "doorway
abuse" as distinct violations; the policy page was last updated 2026-05-15. The
2022 precedent is real: after the helpful-content and spam updates, 200+
service-area-business sites saw their location pages **algorithmically
deindexed**, with low-authority duplicate-content pages hit hardest.

The Presence spec already says "no invented content". That instinct was right
and the reasoning was incomplete — it is not only a trust problem with the
customer, it is an indexing risk to every other tenant on the domain.

## 4. Rules this imposes on Presence

Folded into `docs/spec-presence.md`:

- **Template structure, never prose.** Fill with data the owner entered.
- **A tenant page stays `noindex` until it is genuinely complete** — real
  photos, priced services, and ideally a review. This converts our index from
  "every signup" to "every real business", which is the difference between a
  corpus Google trusts and one it discounts wholesale.
- **If the tradie already has a website, `noindex, follow` our page** and link
  to theirs. Do not cross-domain canonical, and do not compete with our own
  customer for their brand.
- **Churn handling from day one.** Deleted tenant → `410 Gone`. Lapsed but
  intact → `noindex, follow`. Never `robots.txt`-block a page you want
  deindexed — Google cannot recrawl to see the `noindex`. Never bulk-redirect
  dead tenants to a category page; that is a soft-404 doorway pattern.
- **Segment sitemaps by page type** so Search Console tells us which *class* of
  page is being rejected rather than leaving us blind.
- **Keep indexable pages ≈ number of real complete businesses, roughly 1:1.**
  500 tradies × 6 services × 4 suburbs = 12,000 URLs of which maybe 500 carry
  unique information. That ratio *is* the scaled-content-abuse profile.

And if a directory is ever built:

> **Never generate an index page for a (service, suburb) pair with fewer than 8
> genuine active providers.** Below that, 404 or `noindex`. Realistically this
> means **zero indexable directory pages for 12–24 months**, which is fine — it
> costs nothing to defer and everything to launch early.

## 5. What is actually viable

In priority order, from the research:

1. **Reframe (d) from "we rank you" to "we make you rankable."** Google Business
   Profile is the dominant local channel and it is verified against the
   individual business — a platform can help with it but can never *be* it.
   Guided setup, categories, hours, photo prompts, keeping name/address/phone
   consistent with the MakerBay page. Unglamorous, high-value, honest.
2. **Review generation.** Post-job SMS asking for a Google review with the
   direct link. 41% of consumers now always read reviews; 31% will only use a
   business rated 4.5+. This feeds both the local pack and AI citation.
3. **Speed-to-lead — the real wedge, and it is (c) and (e), not (d).** Tradies
   lose jobs by not answering. Converting demand that already exists beats
   creating demand. Measurable, attributable, and the tradie can *feel* it.
4. **Own the branded query.** Be the fast, bookable answer when someone Googles
   the business name after seeing a van. Achievable, and it captures
   word-of-mouth that currently leaks to Facebook and Yellow Pages — a Facebook
   group thread ranked #9 for one of the probes, which is a live demand signal.
5. **Salons are the only vertical where the Fresha pattern applies** —
   appointment-based, price-listable, photo-rich, repeat-visit. Electricians and
   plumbers are emergency call-out businesses where the query is answered by the
   local pack and a phone call.

## 6. Why the directory is the wrong *kind* of business for us

Even in the success case, the arithmetic does not work. Suburb-level service
queries are low-volume, ~68% of Google searches now end without a click, and a
perfectly executed suburb page yields a handful of clicks a month. To build a
business on that you need hundreds of pages, which needs supply we do not have,
and faking it is the doorway pattern. **The channel does not fail at the margin;
it fails at the ceiling.**

There is a second, structural objection. SEO is a *shared* asset: if
`/electricians/newtown` ranked, the tradie does not get a lead — **we** get a
visitor we must then route. That makes (d) a **marketplace** business competing
with hipages, Airtasker and JustDial on their own turf, not a SaaS business.
Different company, different funding requirement. A solo pre-revenue founder on
$80/month should not pick the marketplace.

## 7. Numbers in circulation that are not true

Worth recording, because they will be encountered:

- **"AI Overviews cut clicks 34.5%."** The original study covered
  *informational-intent queries only* and its authors called it correlation, not
  causation. Applying it to `emergency electrician near me` is unsupported.
- **"Local Pack gets 44% of clicks."** Circulates widely with **no traceable
  primary source**. Folklore.
- **"AI Overviews appear on 80% of local service queries"** and **"…on ~7%"**
  both surfaced in the same session from different agency blogs. They cannot
  both be true and neither is verified.

What *is* verified: US zero-click searches at **68.01%** in 2026, up from 60.45%
in 2024 (SparkToro/Similarweb clickstream).

**Also verified and directly relevant:** Google Local Services Ads are **not
available in Australia or India**. That channel does not exist for our markets
until 2027 at the earliest.

## 8. Not measured

- Search volumes for suburb-level queries. No keyword-tool access, so §6's
  traffic reasoning is order-of-magnitude, not measurement.
- Verified AI Overview incidence on local-intent queries. Nobody has published
  credible data.
- Whitespark's ranking-factor weights (blocked).

## 9. What changes in the vision

(d) stops being a product we sell and becomes **a set of features inside
Presence**: GBP assist, review generation, and being genuinely the best
bookable page for a branded search.

The directory is deferred behind a hard density rule rather than cancelled — the
data model should support it, the pages should not exist.

And the ordering in `docs/vision.md` §7 gets stronger, not weaker: Presence
first was already right, and it turns out to also be where the search value and
the search *risk* both live.
