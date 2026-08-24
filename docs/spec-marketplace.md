# Spec: Marketplace directory (find.makerbay.app)

Status: **DELIBERATELY DEFERRED - decision after the first 1000 customers.**
This brief (2026-08-24, second Fable 5 architect, grounded in
docs/analysis-search-visibility.md and docs/vision.md) informs that decision
and defines the cheap pre-work that makes launch a switch-flip.

## Recommendation summary

1. Do not launch a public directory at 1000 customers by default; launch
   per-(city, vertical) cell only when a density gate is met.
2. Vertical-by-vertical inside one city: appointment businesses first (the
   Fresha pattern), not emergency trades; one Sydney region first.
3. A listing page becomes indexable only at **8+ complete businesses** for
   that (service, suburb-cluster) pair; hard 404 below - never an empty shell.
4. Build the taxonomy and geo pre-work now; it benefits Presence and GBP
   assist today and IS the switch-flip.
5. Ranking: completeness → verified activity recency → review score (Bayesian
   damped) → rotation within ties. Published formula. **Never pay-for-
   placement** - the same public promise class as never-gate-reviews. No
   per-lead fees ever (hipages' hated model).
6. No consumer accounts in v1; flows are already tokenless. Attribution via
   `origin: 'marketplace'` stamped on requests/bookings/quotes + timeline.
7. Same CDK stack, hostname find.makerbay.app; listing pages reuse presence
   card data via a `makerbay-listings` read-model table maintained by an
   EventBridge consumer. DynamoDB query per cell - no OpenSearch, no
   free-text search in v1 (category + suburb pickers).
8. Legal: venue not party; licence numbers shown as business-stated claims,
   register-checked per launched cell before any badge; reviews trust story
   is structural ("every review follows a real job"); /report + hide-pending-
   review takedown.
9. India waits until an AU cell proves conversion (JustDial/IndiaMART SERP
   dominance).
10. The go/no-go metric that matters most: organic branded-page traffic and
    booking conversion per tenant - if tenants' own pages don't convert, a
    directory of them won't.

## Data model pre-work (build now, cheap, useful regardless)

- Curated category taxonomy (~30 categories / ~150 canonical services),
  versioned JSON in packages/core; one-question category pick at onboarding.
- Optional `canonicalServiceId` on booking services; free text stays the
  display name. Migration by suggest-and-confirm chips, never silent.
- Structured `serviceAreaIds[]` from the ABS suburb/postcode gazetteer beside
  the free-text list (also improves LocalBusiness markup today).
- `makerbay-listings` read model: PK `categoryId#regionId`, SK tenantId,
  denormalised card fields + completeness score, fed by existing bus events.
- `origin` field on requests/bookings/quotes + contact events.
- Private density dashboard in the admin console: cells vs the 8+ threshold.

## Build at launch (per qualifying cell)

find.makerbay.app behaviour + listing renderer; category/suburb pickers;
the >=8 gate with 404 below; directory sitemap segment; /how-ranking-works;
per-listing opt-out; licence-register checks for licensed trades; venue
terms; "jobs from the directory" attribution surface for tenants.

## Go/no-go gates at 1000 customers

- Any cell with >=8 complete businesses (if zero, the decision defers itself).
- Median bookings per complete page >=2/mo; page→booking conversion >=3%.
- >=40% of complete businesses with 3+ published reviews.
- Paying-tenant monthly churn <3%.
- Honest re-ask of the structural objection: a marketplace is a different
  business - proceed only if the qualifying cell is small enough to run as a
  feature, not a company.

## Coexistence with existing SEO commitments

Tenant pages target branded queries; directory pages target category queries
no tenant page can win - complementary, not competitive. A tenant with their
own website (page noindexed) still appears in listings; their card links
wherever they choose; one-toggle opt-out honoured immediately. Directory
pages are inventory-first data tables - no generated prose, which is exactly
the scaled-content-abuse profile the repo's research warns about. Separate
hostname isolates domain-level risk from tenant pages.
