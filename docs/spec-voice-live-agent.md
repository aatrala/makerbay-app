# Spec: Live voice agent - build/no-build (Nova 2 Sonic vs managed)

Status: **PROPOSED - awaiting founder approval.** Produced 2026-08-24 from the
founder's third-party evaluation (Downloads/makerbay-voice-agent-evaluation.md)
reconciled against the repo's own research (docs/analysis-voice-market.md) by a
second Fable 5 architect. Nothing here is built.

## Decision recommended

**Build on AWS (Amazon Connect + Nova 2 Sonic) - but not yet, and not as a
leap.** Do not sign with Retell. Do not start the 4-6 week build this quarter.
Run a ~1-week, sub-$100 latency probe first, because the single number that
decides everything - real-call median latency - has never been measured for
this architecture by anyone, including the evaluation recommending against it.

## Answers to the founder's questions

**Is Nova 2 Sonic suitable?** As a MODEL, yes - conditionally. It is the only
candidate satisfying both hard constraints at once: the repo's economics (the
market price is ~$29/mo; managed platforms at $0.13-0.31/min mean 100 minutes
can exceed the whole subscription; Nova lands ~$0.04-0.06/min all-in) and the
architecture (grounding from the same Bedrock corpus and business-facts as the
chat assistant, tools against existing REST APIs, in the account we already
run). As a PLATFORM, no - it is a model plus 4-6 weeks of telephony, QA and
failover engineering; the evaluation's 2.6/5 "heaviest build" score is fair.

**Can we go live for English markets?** Not today. Three gates, all cheap and
none yet passed: (a) Chime enablement pending, and the shipped missed-call
rescue is the mandatory safety net - nothing goes live without it; (b) the
latency kill criterion is CLAIMED met (Rel8 CX: 400-600ms on Connect), not
VERIFIED met - the repo's own benchmark excluded Nova because it answers a
socket, not a phone, and its criterion was written against dual-channel
real-call recordings; (c) the repo's precondition "rescue is selling" has no
data yet. Live is plausibly 8-12 weeks out for US, longer for AU.

**Why not Retell-first despite the evaluation's ranking:** the one platform
where the two documents directly collide. The eval's 600-800ms is a vendor
figure; the repo MEASURED 1,740ms median on real calls - the worst of five.
"Days to production" is not a virtue if what ships fails the kill criterion on
day one, at COGS the $29 price point cannot carry.

## Staged plan and gates

- **Stage 0 (now):** chase Chime enablement; ship rescue to ~10 paying
  tenants; wire answered-call → confirmed-booking metric. Gate: rescue
  attaches and converts. If rescue doesn't sell, voice won't either - stop.
- **Stage 1 - latency probe (US, ~1 week, <$100):** one Connect instance in
  us-east-1, one DID, one Nova 2 Sonic session handler, minimal prompt, no
  tenants. Scripted real PSTN calls recorded dual-channel. Gate (both
  documents' criteria): real-call median <1,200ms AND p95 turn <900ms;
  barge-in acceptable on 8kHz audio; fault-injected fallback to voicemail
  verified. Pass → deferral reverses on its own terms. Fail → six weeks
  saved; rescue stays the product.
- **Stage 2 - US pilot (2 weeks, 5-10 tenants):** full build - tools,
  grounding, escalation. Gates: booking success >90% scripted; first-10s
  hang-ups <15%; escalation <40%; gross margin >50%; support <1 day/week;
  zero card-data paths; any customer-reported lost job reverts that tenant.
- **Stage 3 - AU:** deliberately second. Nova has no Sydney region; AU calls
  hop to Tokyo (+80-120ms/turn) and AU/regional accents are the documented
  failure mode. Gates: Stage 2 gates re-run on AU accents through Tokyo
  (recheck regions quarterly); the repo's earlier finding of Connect agentic
  voice at $0.038/min IN SYDNEY with an AU locale is the fallback variant if
  the Tokyo hop fails; counsel-approved WA-standard disclosure.
- **Reversibility:** every stage reverses to shipped code - forwarding flips
  back and callers get voicemail → missed-call rescue, which the repo
  correctly calls a success state. Voice is purely additive risk throughout.

## How it works (chosen path)

Caller dials the business's real number → carrier conditional forwarding
(busy / no-answer / after-hours) → the workspace's dedicated Connect DID.
The contact flow plays the disclosure BEFORE the recorder starts (the WA/SA-
safe design): "Hi, you've reached [Business]'s after-hours assistant. I'm an
AI and this call is recorded so [Owner] gets the details - if you'd rather
speak to a person, press 0 any time." One line covers all eight AU
jurisdictions, US all-party states, and honesty law.

Audio streams to a Nova 2 Sonic session in-region. The system prompt is
generated from the same workspace documents and business-facts as the chat
assistant - both channels give identical answers. Async tools: check
availability → create booking (Bookings), log request (Requests), grounded
FAQ lookup, SMS confirmation. Hard guardrails: never quote a price not in the
documents; never promise a time not in the diary; emergencies (water through
ceiling) transfer immediately. "Press 0"/two failed comprehensions/frustration
→ warm transfer to the owner's mobile; unanswered → "I'll have [Owner] call
you straight back" → the SHIPPED voicemail pipeline (record → Transcribe →
Bedrock extraction → Request + contact + SMS booking link). Nova down or
throttled → health check routes straight to that pipeline. Every call lands a
transcript and summary in the Requests inbox. Payments later: Stripe payment
link by SMS mid-call (zero PCI scope); Connect is PCI DSS L1 if in-call DTMF
capture is ever wanted.

## Packaging

Per-workspace number is technically forced (consumer call forwarding does not
reliably preserve the dialled number, so a shared DID cannot identify the
tenant); ~$2-3/mo each. Voice headlines the **$99 Genie tier: 300 minutes
included** (~80% gross margin), per-second auditable call log, self-serve
cancellation. $29 Trade keeps rescue only; a ~$15/mo 100-minute voice add-on
for Trade comes later once proven. Overage $0.20/min, honest per-minute.
Voice COGS gets its own budget line, never inside the $80/mo platform budget.

## Founder must decide / do

1. Keep pressing the Chime support case - hard blocker for the rescue fallback.
2. Verify Amazon Connect access + number ordering in us-east-1 via a support
   case - Connect is a separate service and likely NOT gated by the Chime SDK
   restriction, but this is unverified; AU DIDs also need business/address
   verification.
3. Confirm Nova 2 Sonic regions, quotas and concurrent-session limits in the
   Bedrock console (volatile).
4. Counsel sign-off on the disclosure line (AU states + ~12 US all-party states).
5. Get a written Retell quote anyway, to keep the reversal option priced.
6. Approve the Genie packaging and the separate voice budget line.
7. Resolve the ServiceM8 phone-agent question before committing AU marketing.
