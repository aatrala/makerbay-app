# Voice agents — competitive and pricing analysis

**Version:** 1.0 · **Researched:** 2026-08-24 · **Scope:** phone answering for SMBs
**Feeds:** `docs/vision.md` item (e)
**Status:** Parts 1–2 superseded in places by Part 3. Read Part 3 first.

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
