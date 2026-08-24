# Voice agents — competitive and pricing analysis

**Version:** 1.0 · **Researched:** 2026-08-24 · **Scope:** phone answering for SMBs
**Feeds:** `docs/vision.md` item (e)
**Status:** Parts 1-3 are superseded in places by Part 4, which reverses the
verdict. Read Part 4 first. Part 5 covers regulation and applies to voicemail
transcription too, not just to the deferred live agent.

Prices were read off vendor properties on 2026-08-24 unless marked otherwise.
Anything not verifiable on a vendor's own site is marked as such and should not
be repeated as fact.

---

## 1. The one number that explains the market

| Vendor | Type | Effective $/min |
|---|---|---|
| Ruby Receptionist | human | $3.45 – $5.00 |
| AnswerConnect | human | $1.75 – $2.50 (overage) |
| **Rosie (heyrosie.com)** | **AI** | **$0.15 – $0.20** |

**A 20–30× gap.** That is the entire competitive story. Everything else in this
document is detail hanging off it.

It also sets our ceiling. Rosie is $49/month for 250 minutes and $149 for 1,000.
Any price we pick lives in that neighbourhood, not Ruby's.

## 2. ~~The finding that changes our position~~ — WITHDRAWN, see Part 3

> **This section was wrong and is kept only so the correction is legible.**

It originally claimed that no vendor integrates with ServiceTitan, Housecall Pro
or Jobber, and concluded that owning the diary was an advantage nobody else had.

That was true of the *horizontal* vendors surveyed in Part 1 — Ruby, Rosie,
Goodcall, Smith.ai — and **false of the home-services-native ones**, which the
first sweep did not cover. Avoca is a ServiceTitan certified app with $125M
raised at a $1B valuation. Sameday is certified too. The gap I thought I had
found does not exist.

Worse, the follow-up research found the field-service platforms have shipped
their *own* voice agents and priced them at $29–32/month or free. **Part 3
replaces this section entirely.** Read that instead.

## 3. Who is actually in this market

**Closest to us: Rosie** (heyrosie.com — note `rosie.ai` is an unrelated
robotics forum). Home services first: plumbing, HVAC, electrical, salons,
property management. $49 / $149 / $299 per month for 250 / 1,000 / 2,000
minutes. 2,000+ businesses, 3.1M calls handled. Founder Jordan Gal (previously
CartHook). Funding undisclosed and thin.

Worth knowing: **Rosie has no per-minute overage.** Exceeding your minutes
auto-upgrades you to the next tier and you stay there until you downgrade. Third
parties widely claim "$0.25/min overage" — that is contradicted by Rosie's own
terms. The real customer risk is a sticky forced upgrade.

**Vertical specialists are where the capital is.** Slang.ai raised $36M in
February 2026 (total $68M) for restaurants; Numa has $55M for auto dealerships
and in April 2026 bought Ficus to go *deeper* into dealerships rather than
sideways into new verticals. Horizontal SMB players are comparatively broke:
Goodcall has raised $4M total, nothing since 2021.

**The read:** capital rewards vertical focus in voice. A tradie-specific product
fits that pattern; a generic one does not.

**The incumbents are not going to fight on price.** Ruby has no AI receptionist
SKU at all — its AI assists human receptionists rather than replacing them.
AnswerConnect devotes a page of its rate card to an explicit "No AI agents"
pledge. Both have chosen human-as-premium. That leaves the middle contested only
by startups.

## 4. Billing units, and why comparison is harder than it looks

Five different units are in play, which is why published comparisons are mostly
nonsense:

| Unit | Who |
|---|---|
| per minute | Ruby, AnswerConnect, Rosie |
| per call | Smith.ai |
| per conversation | Dialpad ($1.99 voice) |
| per **unique caller** per month | Goodcall |
| per location, uncapped | Slang.ai |

Goodcall's is the strangest: a repeat caller costs nothing extra, a one-time
caller costs $0.50. It punishes exactly the businesses with the most new
customers.

**For us:** per-minute is the honest unit for a voice agent because it is what
the cost actually tracks. Per-call invites us to eat a twenty-minute call, and
per-unique-caller penalises growth.

## 5. Smith.ai is the model worth studying

It runs **both** an AI receptionist and a human one, and warm-transfers from AI
to a live human when a call gets complex. AI: free tier (25 calls), $150/month
(~75 calls), $500/month (~300 calls). Human: $300–$2,100/month.

The hybrid is the interesting part. It means the AI never has to be good enough
to handle everything — it only has to know when to stop. That is a much lower
bar than "handles any call", and it is the shape our own failure mode should
take: **escalate, take a message, never bluff.**

## 6. What this does not tell us

Deliberately listed so it is not quietly assumed later:

- **Whether we can hit Rosie's price and make money.** That needs the per-minute
  cost model — telephony, STT, LLM, TTS — which is the other half of this
  analysis and is still running.
- **Whether the latency is acceptable.** Also pending.
- **Numa's pricing.** Not published anywhere; demo only.
- **Slang's call caps.** Genuinely not disclosed. "Unlimited" is a third-party
  claim, and a "starting at" price with no published cap usually means
  volume-based quoting.
- **Ruby's true overage rate.** Not published. Every $/min figure in circulation
  is derived by dividing plan price by included minutes, including mine in §1.
- **Whether any of these actually work well.** There is no independent
  journalism or analyst coverage of this market at all. Every "Ruby vs AI"
  article is written by a company selling against Ruby. Vendor traction claims
  should be read with that in mind — Goodcall claims 42,000 businesses on $4M of
  total funding, which is almost certainly counting trial and dormant agents.

## 7. What this changes

**In the vision:** (e) Voice moves from "highest willingness to pay, highest
risk" to "highest willingness to pay, highest risk, **and the one place we have
a structural advantage nobody else has**". It does not move up the sequence —
Presence still comes first — but it stops being a maybe.

**In the pricing:** anchor around Rosie, not Ruby. Roughly $49/month for a few
hundred minutes is the shape of the market, and per-minute is the right unit.

**In the product:** the minimum viable version is not "handles any call". It is
**answer, understand, book into the real diary or take a message, and know when
to hand over** — with the diary being the part nobody else can copy.

**In the marketing copy:** the honest claim is not "never miss a call". It is
"the job is in your diary before you put the drill down", which is both more
specific and actually true of us and not of them.

---

# Part 2 — Cost model and margin

**Researched:** 2026-08-24. Platform rates read off vendor pricing pages.
Component costs assume an inbound receptionist, ~3-minute calls, 50% agent talk
ratio, low concurrency (free on every platform at our scale).

## 8. What a minute actually costs us

| Path | $/conversation min | What it is |
|---|---|---|
| **Gemini Live speech-to-speech on LiveKit** | **$0.034** | cheapest found |
| Pipecat + own keys (Twilio SIP) | $0.040 | |
| LiveKit + Deepgram + Cartesia + Gemini Flash Lite | $0.041 | |
| Deepgram Voice Agent API | $0.065 – $0.084 | all-in, one bill |
| **Vapi** (orchestration only, we bring the rest) | **$0.086** | managed, least work |
| Twilio ConversationRelay | $0.087 | |
| ElevenLabs Agents | $0.097 | |
| Retell | $0.097 | most transparent rate card |
| **Bland** (LLM + STT + TTS all-in) | **$0.140** | simplest, most expensive |

Telephony floor is ~$0.0085/min inbound plus $1.15/month for a US number.

## 9. The margin question, answered

Rosie sets the market price. Against it:

| At Rosie's price | Revenue | COGS on Vapi | COGS on LiveKit + Gemini |
|---|---|---|---|
| $49 / 250 min | $49 | ~$22 → **55%** | ~$9 → **83%** |
| $149 / 1,000 min | $149 | ~$87 → **42%** | ~$34 → **77%** |
| $299 / 2,000 min | $299 | ~$173 → **42%** | ~$68 → **77%** |

**The business works, but only on the thin-infrastructure path.**

Two conclusions fall straight out of that table:

1. **Bland is disqualified at market price.** $0.14/min against Rosie's
   $0.149/min tier is a 6% gross margin. Any all-in bundled vendor is priced for
   someone charging Ruby's rates, not Rosie's.
2. **Managed orchestration is fine to start and wrong to stay on.** Vapi at 42%
   gross is survivable for a pilot and not a business. The speech-to-speech path
   at ~77% is.

The conventional advice — start managed, move to roll-your-own around 10,000
minutes a month — is right for most people and slightly wrong for us: at our
scale LiveKit's free Build tier (1,000 agent-minutes included, $0/month) is
*both* cheaper and no harder than a managed platform. The usual reason to start
managed is to avoid fixed cost, and here there is none.

## 10. Pilot economics

At 1,000 minutes a month — roughly 330 three-minute calls, a genuinely busy
sole trader:

- LiveKit Build free tier + Gemini Live: **~$28/month**, of which most is
  telephony.
- Same on Vapi: ~$87/month.

**This must not come out of the $80 platform budget.** Voice has real marginal
cost per customer and has to be funded by its own revenue from day one. It is
the first part of MakerBay where that is true, and the budget guardrail needs a
second line rather than a bigger number.

## 11. What is still missing

The AWS-native question is **not** answered here. Amazon Connect, Nova Sonic and
Bedrock-based paths were not covered by this pricing sweep, and they matter
disproportionately for us because everything else already runs on AWS and the
assistant's knowledge base is Bedrock. A separate analysis is still running.

Do not settle the architecture until that lands. On price alone the answer looks
like Gemini Live on LiveKit, but "cheapest per minute" is the wrong question if
it means running the voice product on a different cloud from the knowledge it
has to answer from.

Also perishable: Deepgram's Voice Agent API rises from $0.056 to $0.075/min, and
Flux TTS from free to $0.045/1K characters, on 12 September — about three weeks
after this was researched. Any Deepgram-based estimate above should use the
higher figure.

## 12. Revised verdict on (e)

Before this research: highest willingness to pay, highest risk, unclear whether
the economics work at all.

After: **the economics work at 77% gross on the right architecture, the market
price is set by a thinly-funded competitor, and we have a structural advantage
none of them have — we own the diary.** It stays fourth in the sequence because
Presence still has to come first, but it is no longer speculative.

The thing that would change my mind is the latency finding. A voice agent that
answers 1.5 seconds late is not a cheaper receptionist, it is an embarrassment
the tradie has to apologise for. That number decides whether this ships at all.

---

# Part 3 — What the home-services research found

**This supersedes Part 1 section 2.** Parts 1 and 2 surveyed horizontal AI
receptionists and voice infrastructure. This covers the vendors and platforms
that actually sell to trades, and it changes the conclusion.

## 13. The correction

I claimed nobody integrates with the systems tradies run their jobs in. Wrong.

| Vendor | FSM integrations | Raised |
|---|---|---|
| **Avoca** | ServiceTitan (certified), Housecall Pro, FieldRoutes | **$125M at a $1B valuation**, Apr 2026 |
| **Sameday** | ServiceTitan (certified), Housecall Pro, FieldRoutes, Job Nimbus | ~$500K, YC W23 |
| **Probook** | own dispatch layer | **$40M** - a16z + Sequoia, Jun 2026 |
| **ServiceAgent** | Jobber, ServiceTitan, Stripe, QuickBooks | SaaS Labs internal |

The horizontal vendors I surveyed first - Rosie, Goodcall, Smith.ai - genuinely
do stop at Google Calendar and Zapier. I generalised from them to a market I had
not looked at. That is the error.

## 14. The finding that actually matters

**The field-service platforms have shipped their own voice agents, and priced
them at nearly nothing.**

| Platform | Shipped | Price |
|---|---|---|
| **Jobber** | GA Aug 2025 | **$29/mo inc. 30 conversations, $0.79 after - free on Plus** |
| **ServiceM8** | Sep 2025 | **bundled at $32/mo, no metering** |
| ServiceTitan | early access | per-call consumption, unpublished |
| Housecall Pro | Jan 2025 | paid add-on, unpublished |

Jobber and ServiceM8 have made an AI receptionist a **tier-upgrade lever**.
Anyone selling a standalone one at $149 is competing with a $29 checkbox on
software the customer already pays for.

**This invalidates Part 2's margin analysis as a pricing strategy.** I anchored
on Rosie's $149/1,000 minutes. The real floor for anyone on an FSM platform is
$29, or zero.

## 15. What survives

The economics still hold - 77% gross at $0.034/min is true at any price point,
and at $32 bundled a thin-infrastructure path is still profitable where Bland's
$0.14/min would not be.

And the strategic logic survives in a different form. ServiceM8 can bundle voice
cheaply **because it owns the diary**. That is not a counter-example to owning
the diary mattering - it is the proof of it. My mistake was calling it *our*
advantage rather than *the platform layer's*.

> Voice is not a standalone product we can sell at a premium. It is a **bundled
> retention feature for whoever owns the diary**, and we intend to own the diary.

Smaller than Part 1 claimed, and true.

## 16. Who we would actually compete with

Not Avoca - $125M, sitting on ServiceTitan's install base, selling to
contractors with multiple CSRs. Not Jobber or ServiceM8 customers, who have this
for $29 already.

**What is left is the segment MakerBay was already aimed at: the sole trader on
no platform at all.** A paper diary, a mobile, maybe a Facebook page. Nothing
for Avoca to integrate with and nothing for Jobber to bundle into.

Underserved precisely because it is hard to monetise - which is why the free
tier is the right way in. Give away the page, the contacts, the requests and the
quotes; own the diary; then voice becomes possible at $29 in a way it never
could standalone.

**Risk to name:** Simpro Group has a customer-service agent on a public roadmap
of 20+ agents and shipped its AI platform in May 2026. AroFlo, Tradify and
Fergus have no voice agent today. That AU/NZ gap is real and closing.

## 17. India is a different market, and possibly a better one

Verified vendor pricing, ex-GST:

| Band | Monthly | Per-minute |
|---|---|---|
| True SMB | **Rs 800 - 3,000** | Rs 4-8 |
| Growth SMB | Rs 5,000 - 15,000 | Rs 4-6 |

The anchor is consistent: **a human receptionist costs Rs 15,000-25,000/month**.
Above ~Rs 10,000 the ROI story disappears. Sweet spot is **Rs 2,000-6,000/month
with usage at Rs 4-6/min**.

**Costs are lower too.** Sarvam AI publishes Indic speech-to-text at **Rs 30/hour
- Rs 0.50/min** - which is why Indian vendors retail at Rs 4-6/min and hold
margin. US-priced products (CallHippo at Rs 4,400/user plus $0.25/min, roughly
Rs 22/min) are structurally mispriced here.

**The regulatory point is genuinely interesting.** India's TCCCPR framework -
DLT registration, consent scrubbing, the 140/1600 numbering series - is written
entirely around *outbound* commercial communication. Every regulated category is
defined as a call "made by a Sender to" a recipient.

An **inbound** agent answering a call the customer chose to place appears to sit
outside that machinery. That would be a real advantage for an inbound-first
product, and it fits the cheapest verified Indian products being inbound clinic
receptionists at Rs 800/month.

**But this is a reading of the regulation's structure, not an explicit carve-out
TRAI wrote.** The text contains no clause addressing inbound calls at all. This
needs Indian telecom counsel before anything is built on it, and it must not
become a settled assumption just because it is written down here.

Also unverified: a widely-repeated claim that 2026 IT Rules require labelling
synthetic voice. Not found in the Feb 2025 TCCCPR text. Check MeitY directly.

**GST is 18% and it matters.** A registered business reclaims it as input tax
credit so the effective price is the base price. An unregistered micro-business
below the threshold pays it - Rs 2,999 becomes Rs 3,539. That changes the entry
price for exactly the smallest customers.

## 18. Revised verdict

**Before:** highest willingness to pay, unique structural advantage, 77% gross.

**After:** economics still work, the advantage belongs to the platform layer
rather than to us uniquely, and **the price is $29/month, not $149**. Voice is a
reason to stay, not a reason to pay.

Still fourth in the sequence. What changes is what we build it *for*: not a
premium SKU, but the thing that makes a tradie with no software at all choose us
and never leave. **India may be the better first market** - lower costs, clearer
human anchor, favourable inbound regulatory position, and nobody bundling voice
into a platform there.

## 19. A caution about this whole category

Both sweeps flagged it: this is among the worst SEO-spam environments there is.
Essentially every "best AI receptionist" article is published by a competitor.
There is no independent journalism or analyst coverage at all, and every vendor
traction claim is self-reported - Goodcall claims 42,000 businesses on $4M of
lifetime funding, almost certainly counting trial and dormant agents.

More relevant to us: **Air.ai sold this exact product, was sued by the FTC in
August 2025 for false earnings claims, and settled in March 2026 with an $18M
judgment and a permanent ban on its founders from marketing business
opportunities.** Buyers in this category have been burned, and some by something
that looked like us.

That is an argument for the plainest possible claims. "Answers when you cannot,
and the job is in your diary" is checkable. "Never miss a call again" is what
Air.ai said.

---

# Part 4 — Feasibility, and the verdict flips

**This supersedes Part 3's conclusion, including its India recommendation.**
Parts 1-3 answered "is there a market and does the money work". This answers
"does the thing actually work", and the answer changes the decision.

## 20. The kill criterion I set, and it was met

Part 2 ended: *"The thing that would change my mind is the latency finding. A
voice agent that answers 1.5 seconds late is not a cheaper receptionist, it is
an embarrassment the tradie has to apologise for."*

Measured on **real phone calls** (dual-channel recordings, ~420 turns per
platform, last measured 1 August 2026), time from caller stopping speaking to
agent audio starting:

| Platform | Median | p95 |
|---|---|---|
| Telnyx | 1,296 ms | 1,856 ms |
| ElevenLabs | 1,424 ms | 1,768 ms |
| Bland AI | 1,520 ms | 2,248 ms |
| Vapi | 1,558 ms | 2,008 ms |
| Retell AI | 1,740 ms | 2,259 ms |

For reference: ~200ms is natural human turn-taking, under 300ms reads as
instant, ~800ms is where a caller says "hello?" into the gap, and 1,200ms+ is
where they assume the line dropped.

**Every commercial platform sits above the "feels broken" threshold at the
median, on every call.** Not at p95 — at the median.

Vendor claims of 160-400ms for speech-to-speech are lab figures over a socket,
not phone calls. The benchmark excludes Nova Sonic and LiveKit precisely because
those "answer a socket, not a phone", so **there is no comparable real-call
measurement of the architecture we would most likely build.** The gap between
lab and phone is unproven in the direction we would need.

I said this would change my mind. It does.

## 21. Demand is moving the wrong way

A 6,000-consumer study across US/UK/Canada comparing October 2025 to April 2026:

| | Oct 2025 | Apr 2026 |
|---|---|---|
| Would **hang up** if connected to AI | 29% | **31%** |
| Prefer a real person | 83% | **85%** |
| Frustrated by AI agents | 54% | **59%** |
| Trust drops if a business mainly uses AI | 53% | **57%** |

**The source sells human answering services and has every incentive to produce
this result.** But it is a large sample, run by a recognised polling firm, with
disclosed methodology and a longitudinal comparison — which makes it better
evidence than anything the AI side has published, and every measure moved
against AI over six months.

Read plainly: **roughly a third of our customer's customers would hang up on our
product.** For a tradie whose problem is missed calls, an agent that causes 31%
of callers to hang up may not beat voicemail. Nobody has published a controlled
comparison of AI receptionist versus voicemail on booking conversion, and that
absence is itself informative.

## 22. Correcting Part 3: India is later, not better

Part 3 said India may be the better first market. That was wrong, and the reason
is structural rather than commercial.

- **Amazon Connect does not offer Indian phone numbers.** India is absent from
  the country list for ordering and porting.
- **Twilio's own India voice guidelines list domestic inbound and outbound as
  "N/A"**, and state that outbound calls to India can only be made from
  non-Indian numbers.

Serving India means integrating an Indian telephony provider (Exotel, Plivo,
Ozonetel) with DLT registration, KYC and multi-day DID provisioning. **A second
disjoint integration and compliance project that roughly doubles the build.**

On privacy I over-stated the fog and then corrected it. The **DPDP Rules were
notified on 13 November 2025** with a phased commencement: the Data Protection
Board immediately, consent-manager registration from 13 November 2026, and
**all substantive obligations from 13 May 2027**. Consent must be "free,
specific, informed, unconditional and unambiguous" by clear affirmative action —
a higher bar than a recording beep, but satisfiable by the same opening
disclosure line we would use in Australia.

So DPDP is a manageable problem with an 18-month runway, and the compliance
clock roughly matches how long reaching India would take anyway.

**India is out of scope for voice today because of telephony, not privacy. That
makes it a later market rather than a never market** — and the attractive
economics in Part 3 §17 remain real, just unreachable for now.

## 23. The AWS-native answer, which is better than expected

Part 2 left this open. It resolves well:

**Amazon Connect agentic voice** — **$0.038/voice minute**, billed per second,
**available in ap-southeast-2 (Sydney)**, with an **Australian English locale
added 20 April 2026** and turn-taking, response pacing and speech controls
handled by AWS.

That last part is the point. The largest cost in a self-built voice agent is not
inference — it is the engineering to make turn-taking, barge-in, endpointing and
interruption recovery feel human, plus maintenance when a model version changes
the behaviour. Connect's price already covers it. Build-your-own lands at
**$0.07-0.21/min all-in** once everything the managed price bundles is included:
*more* expensive, before counting our time.

Nova 2 Sonic explicitly supports Australian English and Hindi and is robust to
8kHz telephony audio — but it is **not in Sydney** (N. Virginia, Oregon, Tokyo),
so a Sydney-to-Tokyo hop adds ~108ms to every turn. On an already-broken latency
budget that is 15% gone before computing anything.

**If we build this, it is Amazon Connect in Sydney.** Not elegant; correct.

## 24. Two source conflicts I am not resolving by picking

**ServiceM8.** One analysis reports a Phone Agent shipped 19 September 2025,
bundled at $32/month, with a detailed capability description and a specific
FAQ-grounding limitation. Another reports ServiceM8 has **not** shipped AI voice
at all, citing their pricing page showing recording and transcription only.

These cannot both be true. The first is more specific in ways that are hard to
invent; the second cites a primary page. **Unresolved, and it matters** —
whether the dominant AU tradie platform already bundles this decides whether the
AU market is defended. Check servicem8.com directly before acting on either.

**Nearly every headline number in this category is fabricated.** The
"$126,000/year lost to missed calls" traces to a call-centre vendor. The "$7
billion Australian SMEs lose annually" originates in a competitor's own launch
press release with no underlying study. A widely-cited "Gartner: 60% of small
service businesses by 2028" appears to correspond to **no actual Gartner
release**. Market-size estimates for the same year returned $2.1B, $2.7B, $4.64B
and $4.8B.

**None of these go in a deck.** They will not survive a diligent investor, and
more importantly they are not true.

## 25. The reputational asymmetry nobody prices

**The failure lands on the customer's brand, not ours.** When the agent mishears
an address, quotes a price the sparkie will not honour, or fails to recognise
"there is water coming through the ceiling" as an emergency, the caller blames
*the electrician*, tells their neighbours about *the electrician*, and reviews
*the electrician*.

For a sole trader whose business is local word-of-mouth, **one bad call can cost
more than the product will ever save them.** Their expected value is not "calls
answered times conversion" — it is that minus "reputation damage times
probability", and the second term is large, uninsurable and unmeasurable.

Accent handling makes this concrete: McDonald's ended its IBM drive-thru
partnership in 2024 with accuracy in the low-to-mid 80s, accents contributing.
Australian and Indian English are exactly the accents most likely to degrade.

## 26. The revised plan: a ladder, not a product

The right shape is three rungs, each shipping independently and each useful
alone. **The first two are not voice agents at all.**

**Rung 1 — Missed-call rescue. No AI voice.**
On a missed call, fire an instant SMS: *"Sorry we missed you — [Business]. Book
here: [link], or reply and we will call you back."* Create a Request. Notify the
tradie.

Days of work. Costs cents. **Zero latency risk, zero hallucination risk, zero
accent risk, zero reputational downside.** And it captures a large share of the
actual value, because the underlying mechanism is speed-to-lead, not
conversation.

**If this does not sell, the voice agent certainly will not.** That makes it a
cheap test of the whole thesis as well as a product.

**Rung 2 — Structured voicemail intelligence. Asynchronous.**
Unanswered calls go to voicemail. Transcribe, extract name, number, job type,
urgency, address, availability. Create the Contact and the Request, SMS the
caller a booking link, push a one-line summary to the tradie, flag emergencies.

No real-time constraint, so **latency is irrelevant**. No chance of the AI
saying something wrong *to a customer* — it only ever talks to our own user.
About $0.01 per call. This is where the existing RAG and Bookings modules start
earning their keep.

**Rung 3 — Constrained live answer.** Only after Rungs 1 and 2 are in paying
customers' hands. Discloses in the first sentence. Captures details and offers a
real slot. **Never quotes prices, never promises a time not in the calendar,
never handles emergencies.** Escalation is the primary feature, not the
fallback: two failed comprehensions or any frustration signal triggers "let me
get [name] to call you straight back" with a full transcript handoff.
**Transcript-and-callback is a success state.**

## 27. Kill criteria, written down now

Adopted, so they cannot be rationalised away later. Revert to Rung 2 if, after
20 real customers:

- more than **15% of callers hang up** in the first 10 seconds
- **any single customer reports a lost job** attributable to the agent
- median latency on real calls exceeds **1,200ms**
- escalation rate exceeds **40%** — the agent is not beating structured voicemail
- gross margin on the voice line falls below **50%**
- it consumes more than **one day a week** of support

## 28. Final verdict on (e)

Across four analyses this went: promising, then structurally advantaged, then
corrected down to a $29 retention feature, and now this.

**The live conversational agent is deferred indefinitely.** Not cancelled —
deferred behind evidence. The technical premise is unmet by every funded
specialist in the category, consumer demand is moving against it on every
measured axis, the price is $29 against a platform that costs $29, India is
unreachable, and the failure mode damages our customer rather than us.

**What we build instead is Rungs 1 and 2, and they belong inside Requests and
Bookings rather than in a module of their own.** Missed-call rescue is
speed-to-lead, which is the mechanism that was doing the work all along. It is
days of effort, it strengthens two modules we have already shipped, and it
carries none of the risk.

That is a smaller answer than "an AI answers your phone". It is also the one
supported by the evidence, and it can ship next week.

**The one line that survives from Part 1:** the honest claim was never "never
miss a call again". It was "the job is in your diary before you put the drill
down" — and Rung 1 delivers exactly that, without a voice agent at all.

## 29. Still needing a lawyer, not a search engine

- **Australian state-by-state call recording consent.** The federal act governs
  interception; the operative rules are state Surveillance Devices Acts and they
  differ. A nationally marketed product that records by default has a per-state
  problem, and recording is not optional because transcripts are the safety net.
  *Mitigation that works regardless:* an unambiguous opening notice — "this call
  is answered by an automated assistant and may be recorded" — addresses
  recording consent and AI disclosure together, in every jurisdiction, for three
  seconds.
- **Whether the Privacy Act small business exemption (A$3m turnover) survives**
  current reform. We would not be exempt for long anyway, since we hold voice
  data across many businesses.
- **Australian AI disclosure is not currently required** — mandatory guardrails
  were shelved in December 2025 — but from 10 December 2026 substantially
  automated decision-making must be disclosed in a privacy policy. Trending
  toward required, nearly free, so disclose.

---

# Part 5 — Regulatory, verified against primary sources

**Why this still matters even though Rung 3 is deferred:** Rung 2 records and
transcribes voicemail. Everything below about recording consent applies to it.
Rung 1 (missed-call SMS) records nothing at all — which is one more argument
for shipping it first.

## 30. Australian call recording: three one-party states, five all-party

| One-party (a party may record) | All-party (every party must consent) |
|---|---|
| VIC, QLD, NT | NSW, WA, TAS, SA, ACT |

**WA sets the design floor.** In NSW, TAS and ACT the party-recording exception
has a limb for recordings *not made for the purpose of communicating them to
non-parties*. **WA and SA have no such limb** — and in any case our product
exists to pass the transcript onward to the business owner, which is exactly
what that limb is drafted to protect. We cannot rely on it.

**One control solves all eight jurisdictions:**

> Disclose **before the recorder starts**, and offer a genuine non-recorded
> path. Continuing the call is then implied consent by each principal party,
> which satisfies even WA without arguing "lawful interests".

Announcing *after* recording begins fails WA and SA outright. Build to WA and
ship nationwide — the cost is one sentence of audio, and per-tenant jurisdiction
config would be a maintenance liability we would get wrong.

This is criminal law with **no small-business exemption**: WA penalties are
$5,000 for an individual and **$50,000 for a body corporate**. Our customer
commits the offence; we supply the instrument.

## 31. A correction worth recording

Multiple sources claim Australia's Privacy Act small-business exemption
(A$3m turnover) "is gone" or is removed on 10 December 2026.

**That is wrong.** The exemption is still in force, confirmed three ways
including the current legislative compilation. **10 December 2026 is the
commencement of APP 1.7–1.9** — automated-decision-making transparency — which
is an unrelated provision. The claim appears to be AI-generated SEO content
conflating two different things.

Removal of the exemption is a *proposal* with no Bill and no date.

## 32. The obligation that actually lands on us

> **We are bound as an APP entity once our own turnover exceeds A$3m, no matter
> how small every one of our customers is.**

Compliance is ours to build as product, not our customers' to configure: the
APP 5 notice, the privacy policy, cross-border disclosures, breach
notification, retention limits and a deletion API.

Two more that bite immediately:

- **Health-service-provider customers are covered at any turnover** — physios,
  dentists, allied health, remedial massage. The exemption never applied to
  them, and clinics are in our target list.
- **The statutory tort for serious invasions of privacy** (in force since June
  2025) is **not gated by the small-business exemption** and covers intrusion
  upon seclusion. Indefinitely retained covert recordings are its paradigm case.

## 33. Product rules this fixes in place

1. **Disclosure before the recorder starts**, with a real non-recorded path. Not
   a customer-configurable setting they can switch off.
2. **Never ship voiceprint speaker identification.** Biometric templates are
   *sensitive information* under the Privacy Act and trigger express consent
   under APP 3.3. An ordinary recording or transcript is not sensitive; a
   voiceprint is. The line is worth staying behind.
3. **Never train models on customer call audio by default.** It destroys the
   "not for publication" limb in NSW/TAS/ACT and breaches DPDP purpose
   limitation. Opt-in, per tenant, or not at all.
4. **Region-pin the data** — ap-southeast-2 for Australia. Makes APP 8 and the
   overseas-country disclosure collapse to nothing.
5. **India needs explicit affirmative consent**, not implied. DPDP requires
   "unconditional and unambiguous... clear affirmative action", so
   silence-equals-consent does not travel. Design a spoken confirmation for that
   flow if we ever reach it.

## 34. What is *not* required, contrary to common belief

- **No ACMA rule requires "this call may be recorded."** The obligation is real
  but comes from state surveillance law and APP 5, not from ACMA. Vendor blogs
  asserting an ACMA disclaimer requirement are unsupported.
- **The Do Not Call Register Act does not apply to inbound calls.** It governs
  unsolicited outbound telemarketing. This flips the moment we add outbound
  callbacks — which Rung 1's "reply and we will call you back" carefully does
  not do automatically.
- **No Australian law currently requires disclosing that a caller is speaking to
  an AI.** Mandatory AI guardrails were dropped on 2 December 2025 in favour of
  existing law plus voluntary guidance.

But **Australian Consumer Law s 18** does bite: actively presenting an AI as a
human — a human name, "I'm Sarah from the office" — is conduct capable of
misleading, and the ACCC has said businesses cannot avoid ACL obligations by
blaming an algorithm. **Disclose because it is honest and because s 18 exists,
not because a specific AI law compels it.**

## 35. Still needs a lawyer

- The WA provision was read at a 2015 compilation; s 5 is still operative but a
  later amendment was not ruled out.
- Whether cloud-side recording sits "in passage over a telecommunications
  system" for TIA Act s 6 is **untested** — no case law or ACMA guidance found
  squarely on cloud-PBX recording. Our mitigation is the disclosure, which
  defeats the "without knowledge" element regardless.
- India's AI-disclosure position and the entire US picture are unverified.
- EU AI Act Article 50 applies from 2 August 2026 and is live today, but a
  proposed "Digital Omnibus" delay could not be confirmed either way. Irrelevant
  without EU customers; the Art 50(2) requirement to machine-readably mark
  synthetic audio is unsolved at 8kHz telephony and is a reason not to sell into
  the EU at all.
