# Voice latency probe - runbook (Stage 1 of spec-voice-live-agent.md)

Status 2026-08-25: infrastructure standing; AI-agent configuration is a
~30-minute console task (Connect's AI agent designer has no API); then
scripted calls + measurement.

## What already exists

- Amazon Connect instance `makerbay-voice-probe`, ACTIVE, us-east-1
  (id c060e3a8-7ac8-4604-beee-e1be4c9c85ab).
- Probe DID claimed: **+1 (414) 219-1295** (~$1.20/mo).
- The architecture decision is settled by AWS's own launch: Connect
  agentic self-service runs Nova Sonic natively (Nov 2025, us-east-1),
  so the probe measures the REAL production architecture with no custom
  KVS bridge and no third-party telephony.

## Console steps (founder, ~30 min - the AI agent designer is UI-only)

In the Connect admin website for `makerbay-voice-probe`
(Connect console → instance → "Access URL" → log in as admin):

1. **AI agent**: AI agent designer → AI agents → Create AI agent → type
   "Orchestration" → copy from `SelfServiceOrchestrator`. Keep the
   default prompt; for the probe add one line: "You are the after-hours
   assistant for Southside Plumbing. Answer questions about plumbing
   services, hours and pricing briefly." No MCP tools needed for the
   latency probe - add one Constant tool `getServices` returning a
   static services JSON so tool-latency is also measured.
2. **Security profile**: Users → Security profiles → create
   `probe-ai-agent` granting the AI agent tool access; attach it in the
   AI agent's Security Profiles section.
3. Publish the AI agent, then AI Agents page → Default AI Agent
   Configurations → set it in the **Self Service** row.
4. **Conversational AI bot**: Routing → Flows → Conversational AI →
   create bot with the Connect Customer AI agent intent enabled.
5. **Contact flow**: create "probe-inbound": Set logging on → Enable
   contact recording (both legs - this is the dual-channel evidence) →
   Set voice → Get customer input (the Conversational AI bot) → Check
   contact attributes on Lex session attribute `Tool`
   (Complete → Disconnect; Escalate → Disconnect for the probe).
6. **Number**: Channels → Phone numbers → +1 414 219 1295 → attach
   "probe-inbound".

## Test protocol (founder makes the calls; ~20 min)

Ten scripted calls to +1 (414) 219-1295 from a real mobile:
1-3: "What are your hours?" / "Do you fix hot water systems?" /
"How much is a leak inspection?" (plain Q&A)
4-6: same questions but interrupt the answer mid-sentence (barge-in)
7-8: "What services do you offer?" (forces the Constant tool call)
9-10: background noise (radio on), speakerphone.
Speak naturally; note the wall-clock feel of each pause.

## Measurement (mine, once recordings exist)

Contact recordings land in the instance's S3 bucket. I will script:
per-turn gap extraction from the dual-channel WAV (end of caller speech
→ start of agent speech), median + p95 across all turns, barge-in
response time, and produce the verdict against the spec's gate:
**median < 1,200 ms AND p95 turn < 900 ms** (both documents' criteria).
Pass → the deferral on building voice reverses on its own terms.
Fail → six weeks saved; rescue stays the product.

## Costs

DID ~$1.20/mo + ~$0.018/min inbound + Nova Sonic seconds + Amazon Q in
Connect self-service usage. Ten short calls: well under $5. Total probe
budget stays under the $100 cap; the instance and DID are disposable
(release the number, delete the instance) once the verdict is in.
