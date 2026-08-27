# Spec: Set it up for me - done-for-you setup (issue 93)

Status: **DESIGNED 2026-08-27, awaiting founder sign-off on this document.**
Blocked on issues 96 and 97; must not ship without 98, 99 and 100. Designed
from seven parallel consults (product flow, pricing, security and liability,
technical architecture, market and competitive, trust evidence, human-in-the-
loop precedent), every structural claim verified against the repo.

## What it is

A layer where the assistant does setup and configuration work FOR a business
instead of making them do it in the UI. A stranger pastes their website,
Facebook page or Google listing into makerbay.app and gets a real draft
business page back in about a minute, with no account and no card. From
there they can keep it, change it, or walk away.

**The founder's principle, and the one that governs every decision below:
every task must ALSO be doable by the customer themselves in the app. This
is a "do it for me" option layered over self-serve, never a replacement for
it.** That is what stops it reading as an admission the product is hard.

## What the evidence says it is

Not a revenue line. At $10 across a handful of tasks it adds $10-40 one-off
against a $29/mo subscription - a rounding error on revenue, and the
difference between an activated account and a dead one. It is an
**activation and retention instrument**, and the free first pass is the part
doing the work.

Two market findings shaped the pricing:

- **Willingness to hire setup out is falling**: 51% -> 66% -> 71% preferring
  self-service over agencies, 2022-2025.
- **The vendors who solved this absorbed it rather than sold it.** ServiceM8
  refunds up to $2,000 of setup cost; Jobber bundles a specialist into its
  top tier; GlossGenius does migrations free and earns reviews like "I didn't
  even have to set up my client transfer at all". The one vendor that
  line-items onboarding is HubSpot at $3,000 mandatory, and it is the most
  complained-about fee in SMB software.

$10 sits at the absolute floor of the market: level with Fancy Hands' per-
request rate, below every human alternative, against 6,600 Fiverr sellers
doing Google Business Profile setup from $5. It cannot signal quality. The
free artifact signals quality instead, which is why the free pass is
load-bearing rather than promotional.

## Decisions of record (founder, 2026-08-27)

1. **Set-up and update pairs MERGE into one job each.** The customer does not
   care which one it is, and pricing them apart invents an argument.
2. **The first pass is free and produces something visible**, with no account
   and no card. The charge is to make it live and correct.
3. **Free on any paid plan; $10 only on the free tier.** This makes $10 an
   anchor that sells the $29 plan rather than a revenue line, and makes the
   subscription stickier. It is the sharpest available use of that number.
4. **Pay only after the customer confirms.** Scope is frozen at acceptance;
   **revisions are unlimited**.
5. **"Move me over" is $49**, not $10. It is the most expensive task to
   deliver, the likeliest to need a person, and the named switching cost
   across every competitor's review corpus.
6. **The $20 Stripe Connect task is killed.** Stripe gives every user free
   24/7 phone, chat and email support, and what we would be troubleshooting
   is our own onboarding flow. Charging for that is charging for a defect.
7. **Access is a one-tap grant**, not a relayed login code. See "Access".
8. **Passwordless email sign-in** becomes the default for owners. Separate
   improvement, issue 110, neither depends on the other.

## The menu

| Job | Free tier | Paid plans | Covers |
|---|---|---|---|
| Setup review | Free | Free | Five minutes, what is missing, what to do next. No upgrade pitch unless asked. |
| Your page | $10 | **Free** | Build or change the public page from a website, listing or notes. Reviewed, live. |
| Your assistant | $10 | **Free** | Build or change what the assistant knows. Tested with real questions in front of them. |
| Your help centre | $10 | **Free** | Build or change the help pages. |
| Services and diary | $10 | **Free** | Services, prices, durations, buffers, working hours, holidays. |
| Get found on Google | $10 | **Free** | GBP checklist, categories, service areas, NAP consistency. |
| Set up reviews | $10 | **Free** | Ask timing, the wall, the no-gating pledge. |
| Quotes and invoices | $10 | **Free** | Price list, document prefix, ABN/licence footer, deposit percentage. |
| **Move me over** | $49 | $49 | Customer list and price list from a spreadsheet, a competitor export, or a photo of a price sheet. |
| Something else | $49 | $49 | Tell us. We say yes or no within one business day, free. You only pay if we say yes. |
| A person, on a call | $99 | $99 | **45 minutes**, booked at a time you pick, on your screen. Full refund if we do not finish what we agreed. |

**Launch with three plus the call**: Your page, Your assistant, Services and
diary, and the $99 session. Add the rest when the escalation numbers hold.

**Naming.** Customer-facing this is **"Set it up for me"**. Never
"concierge", which is a hotel word for a customer who is under a sink. The
unit of work is a **job**. Internally the module is `setup`. Do not put the
name Genie on it: Genie is the $99/mo tier and reusing the name will make
people think this is a subscription.

### Why the human session is capped at 45 minutes

At 90 minutes, $99 is about $66/hr, below a skilled specialist's loaded cost,
and it stops making sense. Comparables: Clarity.fm clears at $150-480/hr;
Birdeye's single-location onboarding is reportedly a ~90-minute call at
$300-1,500. Free alternatives exist (SCORE gives 1:1 mentoring free in all 50
states), so the session must be a **working session where changes get made on
screen**, not advice.

### The pricing rule for anything added later

**Any task whose median human-minutes exceeds ~20 belongs at $49 or in the
subscription, never at $10.** Measured agent completion on long-horizon
professional tasks is ~30% (TheAgentCompany), 14% on web tasks (WebArena),
35% on multi-turn CRM tasks (CRMArena-Pro, Salesforce's own benchmark).
Human fallback is the normal case on complex jobs, and the jobs that fall
back are the long ones. Instrument before publishing any new price.

## The flow

### States

```
Looking -> Scoping -> Quoted -> Held -> Working -> Ready -> Confirmed -> Closed
                          |                          ^  |
                          |                          |  v
                          +-> Released            Revising (unlimited)
Side exits: Blocked (needs you), Blocked (needs a person), Refunded
```

### Screens

| Screen | Where | What it is |
|---|---|---|
| Hero starter | `makerbay.app/` | One field, one button |
| Job page | `makerbay.app/setup/{jobId}` | Thread left, artifact right, changes underneath. Resumable from a link |
| Menu | `makerbay.app/setup` | The table above. Footer-linked, not a nav item |
| Handover | a state of the job page | Account created, receipt, what changed, what next |
| Change log | job page + dashboard Activity | Every write, before and after, with undo |

The job page is a **page, not a chat bubble**. A 380px widget is the wrong
container for reviewing a business page. Reuse `chat.js`'s identity lockup
and card patterns, not its shell.

### Step by step

1. **Looking.** Free, no account, no card. They paste an address; within
   about twenty seconds the job page opens with a real draft page rendered at
   a preview URL. If there is nothing to read, the agent says so and **does
   not invent a business** - the `copy.ts` rule that forbids inventing
   services, prices, certifications, licence numbers, years in business,
   guarantees or service areas applies here as a server-side validator, not a
   prompt instruction.
2. **Scoping.** At most **three questions**, and only ones the agent cannot
   answer from what it read. The fourth question is where a tradie closes the
   tab.
3. **Quoted: the scope card.** Server-rendered from a structured scope
   object, never from model prose - the same construction rule as Genie's
   confirmation cards. States what it will do, what it will not do, what it
   needs from them, and that they are not charged until they say it is right.
4. **Held.** Email and card. Stripe Payment Element, guest checkout, **manual
   capture**. No account is created at this point. The email gives a
   resumable magic link back into the job.
5. **Working.** Streamed status lines in plain sentences, preview updating as
   fields land. Two to four minutes for a page.
6. **Ready.** The review screen (below).
7. **Confirmed.** One button applies the whole changeset. For a stranger this
   is where three things happen at once: the workspace is created, the changes
   apply, and the page goes live.
8. **Released.** Rejection voids the authorisation. No money ever moved. The
   preview link stays alive for 30 days.

### The money, precisely

| Event | Money |
|---|---|
| Quoted | Nothing |
| Held | Authorisation, manual capture |
| Confirmed | Capture |
| Released | Void |
| **Day 6 with no confirmation** | **Capture, with an honest message** (see below) |
| Within 14 days of Confirmed | One tap "put it back", automatic refund, no questions |

**The day-6 rule exists because revisions are unlimited.** Card
authorisations expire around day seven, so an open-ended job would silently
lose its hold. At day 6 the hold captures and the customer is told plainly:

> I have taken the $10 because the hold was about to expire. If you are not
> happy with the result I refund it, same as before.

The 14-day no-questions refund is cheap at $10 and it is the line that makes
the service safe to try. Print it on the scope card.

### The confirm loop

Unlimited revisions, with two brakes that cost nothing:

- **Scope is frozen at acceptance.** Anything on the scope card, the agent
  does, however many times it takes. Anything not on it gets classified (see
  Scope control).
- **On the third revision the agent escalates to a person, free, on its own
  initiative.** A job that reaches round three was heading for a refund and a
  bad word anyway. The customer is told the person can see the whole
  conversation so they do not have to explain it again, and that they are
  still not charged for that person's time.

### The review screen

Split view; on mobile a two-tab switcher with **Preview first**, because
seeing it is the point.

- **Preview is the real renderer at a real URL**, unpublished, `noindex`,
  token-protected. `POST /v1/presence/preview` already does exactly this. A
  screenshot or a description is not acceptable: they are buying a thing that
  looks a certain way.
- **Changes are a server-rendered field-level diff**, grouped by where they
  live, every row with its own "Change this". Never model prose.
- **A "not changed" section.** Telling someone what you did not touch is how
  a change list feels safe.
- Three buttons: `Looks right, publish it` / `Change something` / `Not right`.
  "Change something" is the revision mechanism and must be as prominent as
  confirm.

### Scope control

Every message after `Held` classifies into one of five buckets:

| Bucket | Agent does |
|---|---|
| Correction | Do it. Free. Unlimited. |
| Neighbour (another menu job) | Offer it as a line on the same order, **after** showing the finished work, once, with a real "No thanks" |
| Bigger | Route to $49 feasibility, free to ask |
| Not our software | Free written instructions, or the $99 call |
| Never | Refuse, with the reason |

Three rules keep the neighbour case from reading as a shakedown: never hold
the current job hostage, never ask twice, and **no subscription upsell inside
a job at all**. If a job requires a paid module, that goes on the scope card
before payment.

## Access

**A one-tap "Set this up for me" button**, not a relayed login code.

### Why not the OTP relay

There is no OTP login in MakerBay today. `packages/web-kit/src/api.ts` makes
exactly three code-bearing Cognito calls - `ConfirmSignUp`,
`ForgotPassword`/`ConfirmForgotPassword`, and `InitiateAuth` with
`USER_PASSWORD_AUTH` - and the customer pool (`makerbay-stack.ts:386`) has no
`mfa` property at all. The emailed six-digit code is therefore a signup
verification code or **a password-reset credential**, so "enter their OTP"
means an account takeover ending with MakerBay holding the customer's
password.

Note the asymmetry: `staffPool` is MFA-required, 14-character passwords, no
account recovery, 8-hour refresh tokens. The customer Dashboard client sets
no `refreshTokenValidity` at all and inherits Cognito's 30-day default.

**Even once real OTP login ships (issue 110), relaying a code to staff stays
wrong.** It trains customers in the exact script of every OTP fraud, and it
forecloses ever saying "we will never ask for your code". The grant button is
also *less* friction: one tap inside an app they are already signed into,
versus opening an inbox and reading six digits aloud.

### The mechanism

A named, time-boxed, revocable delegated principal, scoped to one job.

- **A third API key type**, `delegation`, prefix `mb_dk_`. `ApiKeyRow` already
  has `tenantId`, `keyId`, `keyHash`, `type`, `scopes[]` and the `byHash` GSI.
  Add `expiresAt` (required for delegation), `taskId`, `issuedTo`.
- `CallerContext` gains `taskId` and `onBehalfOf`.
- TTL is the shorter of the job's remaining wait plus an hour, or 48 hours,
  **re-minted on each resume** rather than issued once for the whole job.
- Revocation is `deleteApiKey`, which already exists.
- **The worker re-reads job status immediately before every write.** This is
  the mitigation for the authorizer's 5-minute result cache: a cancelled job
  stops on the next write even if its token is still cached as valid.

### Scoping a job to its resources

Scope alone is coarse. `plan.resources` is fixed at `scoped` and immutable
afterwards; before every write the worker asserts the target is in it. **A
step wanting a resource outside the plan fails the job rather than
escalating.** Scope creep produces a refund and a new plan, never a wider
token.

### Consent

Written at the moment the customer approves the plan, as an immutable event
row carrying scopes, resources, source URLs, price, IP, user agent, and
**the exact words on screen, stored verbatim rather than summarised**. The
point of a consent record is to answer "what were they actually shown", and a
paraphrase cannot.

## Security non-negotiables

Ordered by severity. The first two are hard blockers.

1. **Scope enforcement must exist first (issue 96).** Exactly three places in
   the codebase read `ctx.scopes` and all three treat it as `=== '*'`. No
   module handler enforces a named scope, and `mb_sk_` keys carry `['*']`.
   "Give the concierge limited access" is not currently expressible. Add
   `requireScope(ctx, scope)` in `packages/core/src/http.ts`, called at the
   top of every mutating route. Additive: `'*'` keeps every existing caller
   working.
2. **`PendingAction` must be bound to its proposer (issue 97).** The key is
   `${tenantId}#action#${actionId}` with no record of who proposed it, and
   `confirmAction` checks only tenant, status and expiry. **The moment a
   MakerBay principal is a member of a tenant it can confirm its own
   proposals**, and the confirmation card becomes decoration. Add
   `proposedBy` and require the confirmer to be a different principal and an
   owner.
3. **Fix the injection boundary before an agent fills a knowledge base
   (issue 98).** `rag.ts` `buildPrompt` puts retrieved chunk text into the
   SYSTEM prompt with no untrusted-data framing, while Genie and `copy.ts`
   both carry the correct line. Fix regardless of this spec.
4. **Audit and version every surface before the agent touches it (issue 99).**
   Booking config, booking services including `priceCents`, assistant sources
   and assistant config are all unaudited and unversioned today.
5. **Undo must be free (issue 100).** `listVersions` and `restoreVersion`
   return 402 on the free tier. Charging to change something and then
   charging a subscription to undo it is indefensible when MakerBay made the
   change. **Permanent free undo is also one of only three genuinely unowned
   positions in this market** - see Positioning.
6. **Nothing publishes without a staged draft the owner approves.**
   `DEFAULT_PRESENCE.published` is `true` and there is no draft state.
   `modules/presence/api/src/copy.ts` is the reference implementation: the
   endpoint writes nothing, the draft lands in unsaved form state, the owner
   presses the existing Save.
7. **Hard schema bounds on money and time.** The agent may not set a price to
   zero, move a price beyond a configured percentage, or extend availability
   past declared hours, without an explicit typed confirmation.
8. **Claim allowlist for public copy, server-side.** Licence numbers, ABN/ACN,
   insurance, certifications, awards, years in business and guarantees are
   **never importable from a scrape**. The owner types them or they do not
   exist.
9. **Verify domain ownership before scraping on a paid job**, and never
   publish scraped text verbatim. Two source classes: *owned* (verified, may
   inform published copy) and *reference* (unverified, may be read to ask
   questions, never published). Never import third-party reviews.
10. **Terms, a privacy policy and a refund policy must exist.** `site/src`
    contains none of them today, and this sells outcome-promised services.
    Assume non-excludable consumer guarantees rather than assuming terms
    exclude them.
11. **Disclose AI versus human** at purchase, in the receipt, and in the
    audit log. The $99 session must be a real person; screen share is
    view-only by default.

### Prompt injection

**A model call may hold tool access, or untrusted content, never both.**
Enforced by what is passed to `ConverseCommand`, not by prompt text.

- **Tier A, Planner/Actor**: tools, trusted input only. Never sees raw scraped
  text.
- **Tier B, Extractor**: raw scraped text, **no `toolConfig` at all**. Returns
  only a fixed JSON schema.
- **Tier C, Validator**: deterministic code. Schema-validate, length-cap,
  strip markup. Tier B output enters Tier A **as a tool result, never in a
  system prompt**.

URLs found inside scraped content are never followed; the URL list is fixed
at `scoped` and part of the consented plan.

## Architecture

Summarised; the full reasoning is in the architecture consult.

- **A new module, `modules/setup/`, not an extension of Genie.** `genieFn`'s
  IAM is deliberately read-only across every module table, with a comment
  saying v1 cannot change a thing and the policy says so as loudly as the
  prompt. Adding writes to that role destroys the guarantee.
- **Extract Genie's confirmation machinery into `packages/agent-kit`**:
  `WriteTool` propose/execute/audit, `PendingAction` rows, `apiCall`,
  `confirmAction`. Preserve the load-bearing property that **the agent never
  holds a credential** - the executor forwards the human's own token.
- **Extract `scrape.ts` into `packages/scrape`.** It is the strongest file in
  the repo: SSRF defence with an IPv6 allowlist, re-checked on every redirect
  hop, 2MB streamed cap, honest user agent, robots.txt honoured. **Never fork
  the SSRF guard.**
- **Step Functions Standard, parked on a task token at each human gate.** The
  binding constraint is not Lambda's 15 minutes - every step fits. It is the
  two-day human wait. Do not copy Genie's 600-second card expiry.
- **Tables**: `SetupJobs` (tenantId/jobId, GSIs byStatus and byPaymentIntent),
  `SetupArtifacts`, `SetupEvents`, `SetupProspects`, `SetupVerifications`.
- **Payments run on the platform Stripe account**, not Connect, `mode:
  'payment'`, `capture_method: 'manual'`. Webhook events forwarded onto the
  `makerbay` bus, mirroring the existing Connect rule.
- **Idempotency**: `${jobId}#${stepId}`, deliberately excluding attempt
  number. **Fix issue 95 first** - `usage-aggregator.ts` ignores
  `idempotencyKey` entirely, and a state machine with retries will double-count.
- **Failed jobs open a ticket** in the existing support queue carrying the job
  id, transcript, scope card and preview link, so staff have everything
  without the customer repeating themselves.

## Positioning

**The trap is naming the labour.** Every word describing the work - setup,
onboarding, implementation, configuration, concierge, done-for-you - tells the
buyer there is work to be done.

- **Use the outcome, in the customer's own noun.** "Paste your Facebook page.
  Get your page back." "We'll move your customer list over."
- **Put it inside the flow at the moment of friction**, never on the pricing
  page as a service tier. A service tier is an admission; an inline button is
  a convenience.
- **Avoid**: concierge, onboarding service, implementation, setup fee,
  professional services, white glove.
- **Do not say "our AI will configure your account."** Only 22% of SMB owners
  are completely confident AI can handle even low-level tasks unsupervised
  (Bluevine 2026, n=942). Say the mechanism: "It writes a draft. You look at
  it. You keep it or bin it."

**The one sentence that defuses the whole trap**, said plainly next to the
offer:

> You can do all of this yourself in the app - it takes about ten minutes. Or
> tap "do it for me".

That converts a setup-help offer from evidence the product is hard into
evidence it is fast. **It is only credible if the self-serve path really is
ten minutes**, which makes fixing onboarding and shipping this the same
project, not competing ones.

### What is actually differentiated

The approval gate is **table stakes**, not a differentiator: Jobber ships
"AI recommendations you review and approve before anything goes live", and so
do Zapier, n8n, Gumloop, Lindy, Intercom and Copilot Studio.

Three positions are genuinely unowned:

1. **Pay only on confirm.** No vendor bills strictly on explicit customer
   approval. Every outcome model bills on the agent's own judgment of success
   (Salesforce $0.10/action, Microsoft ~$0.04/action) or on customer silence
   (Intercom $0.99/outcome when the customer "doesn't ask for more help",
   Zendesk $1.50 after a 72-hour quiet period).
2. **The free first pass with no account and no card.**
3. **Permanent free undo.** "I can't roll this back" and "I can't get my data
   out" are the loudest complaints in every incumbent's review corpus.

**Lead with: "See it before you have an account, pay only if you keep it,
undo it forever."**

### The hero

Replace the two competing CTAs with **one field and one button**:

> # Show us your business. Get a page back.
>
> Paste your website, your Facebook page or your Google listing. We will
> build you a working business page in about a minute, with your services,
> your prices and your hours on it. Free, no account, and nothing goes public
> until you say so.

No prices on the hero. The first price a visitor sees is one number attached
to a page they are already looking at.

**The waiting state is the demo.** The twenty to sixty seconds between the
button and the page must not be a spinner. Show the work in plain sentences:
"Reading harbourplumbing.com.au / Found 6 services / Found prices on 4 of
them / Could not find a photo / Building your page." That sequence advertises
a grounded, honest assistant better than any paragraph.

## Build plan

| Phase | Work | Days | Blocked? |
|---|---|---|---|
| **0. Prerequisites** | Issue 96 scope enforcement, 97 proposer binding, 95 idempotency dedupe, `'setup'` actor type in audit | **3** | No |
| **1. Shippable v1** | One job type, "Your page from your website", signed-in owners only. `packages/agent-kit`, `packages/scrape`, `modules/setup`, tables, state machine, one confirmation gate, ownership verification, Tier A/B/C split, dashboard screen | **8-10** | No |
| **2. The rest of the menu** | Assistant, help centre, services and diary, Google, reviews, quotes. New tool definitions against the phase 1 machine. If the machine needs changing here, phase 1 was wrong | **5-7** | No |
| **3. Paid jobs** | $49 "move me over" and custom, $99 human session (a booking in the MakerBay HQ workspace plus a support ticket, not a new scheduler) | **4-6** | No |
| **4. Strangers** | Prospect records, unauthenticated route with per-IP and per-email caps, claim flow, the hero field | **6-8** | Partly - see below |
| **5. Audit and undo backfill** | Issues 99 and 100 across booking config, services, assistant sources | **3** | No |

**Total roughly 29-37 developer-days.**

### Known blockers

- **SES sandbox (issue 76)** bounds phase 4 hardest: no task-ready
  notification, no nudge, no receipt, no refund notice, no claim link for
  strangers. A stranger flow with no email has no follow-up. Resend (issue 94)
  removes this.
- **The stranger endpoint is the most abusable surface the platform would
  have** - unauthenticated, triggering headless Chromium and Bedrock behind a
  platform-wide throttle only. Issue 47 phase 2 (CloudFront + WAF) becomes
  materially more attractive the day phase 4 ships.
- **Genie's Bedrock IAM is `resources: ['*']`** while assistant and presence
  are scoped to Haiku ARNs. Use the tighter pattern here and list models
  explicitly.

### Instrument from job one

Confirm rate, release rate, revision rounds per job, escalation rate, minutes
from Held to Ready, and **cost per job in model and scrape spend**. A job type
that escalates on more than one in five jobs is not a product, it is a support
queue with a price tag, and it should come off the menu until the underlying
screen is fixed.

**The thing this is worth beyond the money:** every job is a recorded, paid,
high-signal observation of exactly where setup is hard, with a human
confirming or rejecting the result at the end. Nothing else in the roadmap
produces that. If the revenue is a wash, the failure log alone justifies it,
and every job that stops needing a person is a screen that got fixed.

## Not building

- **Item (m)/(o), the $20 Stripe Connect task.** Killed. Stripe's docs forbid
  sending Account Link URLs outside the authenticated application and require
  the account holder to enter their own identity details and accept the
  Connect agreement personally. MakerBay carries Express loss liability, so
  filling the form for them takes on Custom-tier liability while keeping the
  Express integration. Guidance and post-onboarding payout diagnostics are a
  **free feature of the payments module**.
- **Per-competitor importers** (Jobber, ServiceM8, Fresha exports). Held.
  Generic "move me over" first.
- **Any auto-apply tier.** The setup agent reads untrusted content by
  definition, so taint escalation fires on every job and every write is
  confirmation-gated, always.
- **A revision counter.** Unlimited, with a free human handoff on round three.
