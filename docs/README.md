# docs/

What each document is and whether it still binds. Statuses: **research**
(evidence, still true until re-run), **shipped** (describes something built -
the code is the truth, the doc records the why and the as-built deltas),
**proposed** (awaiting founder approval - nothing built), **deferred**
(decision parked behind an explicit trigger).

## Product direction

- [vision.md](vision.md) - the thesis. Still the north star: a tradie should
  be found, answered and booked without lifting a finger.
- [market-research.md](market-research.md) - **research** behind the module
  portfolio and free/paid split.

## Shipped specs (code is the truth; docs carry rationale + deltas)

- [spec-presence.md](spec-presence.md) - business pages, honest indexing,
  themes, reviews section, Presence Pro custom domains (addenda at end).
- [spec-requests-bookings-quotes.md](spec-requests-bookings-quotes.md) -
  the free workflow spine, plus reminders, revisions and simple invoices
  (addendum at end).
- [spec-stripe-connect.md](spec-stripe-connect.md) - payments via Stripe
  Connect. Shipped for invoices + quote deposits; booking deposits deferred.
- [spec-marketing-site.md](spec-marketing-site.md) - the generated site.
  The manifest-driven build still holds; homepage structure has since moved
  to journey/personas/trust with real screenshots (see site/).
- [website-knowledge.md](website-knowledge.md) - point-at-your-site imports
  and source transparency. Shipped, including the JS-rendered-site fallbacks
  (markdown twins, __NEXT_DATA__, llms.txt-first).
- [design-guidelines.md](design-guidelines.md) - visual language for every
  surface. Binding.

## Research that decided things

- [analysis-voice-market.md](analysis-voice-market.md) - **research** that
  deferred live voice agents and shipped missed-call rescue instead. Its
  kill criteria are the gates in spec-voice-live-agent.md.
- [analysis-search-visibility.md](analysis-search-visibility.md) -
  **research** behind the noindex-until-complete rules and the Get found
  module; also constrains the marketplace SEO design.
- [research-tooling.md](research-tooling.md) - how to use the connected
  research MCPs (Bright Data, Apify).

## Proposed (awaiting founder approval - do not build from these yet)

- [spec-genie.md](spec-genie.md) - conversational admin for owners (~$99
  tier) + the platform audit log.
- [spec-voice-live-agent.md](spec-voice-live-agent.md) - live voice agent:
  Connect + Nova 2 Sonic, latency-probe-first staged plan.
- [spec-admin-support.md](spec-admin-support.md) - admin console gap
  analysis; P0 list to make support workable.
- [pricing-proposal.md](pricing-proposal.md) - tier-based pricing variants
  (Variant A recommended: Free / Trade $29 / Genie $99).

## Deferred (explicit trigger before any build)

- [spec-marketplace.md](spec-marketplace.md) - consumer directory. Decision
  after the first 1000 customers; cheap pre-work list inside.
