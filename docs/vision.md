# MakerBay — the vision

**Version:** 1.0 · **Date:** 2026-08-24
**Status:** the frame everything else is judged against. Module manifests stay
the source of truth for what each module *is*; this says what they are *for*.

---

## 1. The shift

MakerBay started as "modular business tools an SMB can plug in one at a time".
That is a true description of the architecture and a weak description of the
product. It asks the customer to have a plan.

The sharper version:

> **A tradie should be found, answered and booked without lifting a finger.**

Same platform, same modules, one customer and one outcome. Everything below
follows from that sentence.

## 2. Who this is for

A solo or small service business that sells time and skill: electricians,
plumbers, cleaners, mobile mechanics, landscapers, salons, tutors, clinics.

What is true of all of them, and decides the whole design:

- **They are holding a tool, not a phone.** Every interaction has to work
  without them being at a desk.
- **A missed call is a lost job**, not a lost message.
- **They do not buy software.** They buy more work, and fewer evenings doing
  admin. "AI assistant" is not a thing they want; "answers the phone when I am
  under a sink" is.
- **They are not going to configure anything.** If setup takes an afternoon,
  it does not happen.

This is a narrower customer than "SMBs" and that is the point. A product for
everyone is a product nobody chooses.

## 3. What we sell

Five things. Everything else is free, because everything else exists to make
these work.

| | Product | The job it does |
|---|---|---|
| **a** | **Assistant** | Answers customers from the business's own documents, on the web page, the widget, or by link. |
| **b** | **Bookings** | Turns "are you free Thursday" into a confirmed appointment without a phone call. |
| **c** | **Presence** — a page per business | The thing customers actually land on: who you are, what you do, when you are free, book now, ask anything. Auto-created, editable, at a slug. |
| **d** | **Visibility** | Being findable for "[service] near [suburb]" — a directory across every business on the platform, plus each one's own page. |
| **e** | **Voice** | Answers the phone when the shop is shut or the person is up a ladder. Takes the booking or the callback. |

### Why these five and not others

**(c) is the product; (a), (b) and (e) are how it converts.** A tradie does not
want an assistant, a booking engine and a voice bot. They want a page that gets
them work. The other three are what makes that page do something when a
customer arrives on it — at 9am from Google, at 11pm from a phone call.

**(d) is the acquisition engine and the moat.** One page ranks for nothing. Two
hundred pages, all fast, all structured, all genuinely about a real business in
a real suburb, is an asset that compounds and that a competitor cannot copy by
writing code. It is also the hardest and slowest of the five, and the one most
likely to be oversold. See §6.

**(e) is the highest willingness to pay in the whole portfolio** and the highest
risk. A missed call is real money; a voice agent that mishandles a customer is
worse than voicemail. See §6.

## 4. What is free, and the rule behind it

**Free: Contacts, Requests, Quotes, the help centre, and the business page
itself.** Paid: Assistant, Bookings, Voice, and placement in the directory.

The rule, stated once so it can be applied to anything new:

> **Free if it costs us close to nothing per use *and* it makes a paid thing
> more valuable. Paid if it carries real marginal cost or is a destination in
> its own right.**

That is why Contacts is free (it costs a DynamoDB write and it is what makes
every other module joined-up), why Quotes is free (cheap to run, and a tradie
who quotes through us is a tradie whose customers are in our Contacts), and why
the Assistant is not (every answer is a Bedrock bill).

It is also a growth argument, not charity. A free module that fills Contacts
with real customers is customer acquisition. The alternative — charging $5 for
Contacts — would raise almost no money and cost us the thing that makes the
platform cohere.

**The one to keep watching:** Quotes has the highest willingness-to-pay of
anything currently free. A tradie who wins six $800 jobs a month through it
would happily pay. Giving it away is a deliberate acquisition bet, and it is
worth revisiting once there are paying customers to measure it against — not
because the reasoning is wrong, but because it is the most expensive free
decision in the list.

## 5. How the pieces fit

```
                    someone searches "electrician Newtown"
                                    │
                            (d) Visibility
                                    │
                                    ▼
                      (c) the business's page
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              (a) Assistant   (b) Bookings    call the number
              answers their   picks a real          │
              question        free slot        (e) Voice, when
                    │               │          nobody can answer
                    └───────────────┴───────────────┘
                                    ▼
                    Contacts — one record, one history
                                    │
                        Requests · Quotes · Bookings
                            all hang off that record
```

The arrow that matters is the last one. Five products that each keep their own
customer list are five tools. Five products that write to one contact record
are a system, and the system is what a competitor cannot assemble by shipping
one more feature.

## 6. What we are honest about

Written down here so it cannot be quietly forgotten when the marketing copy is
being drafted.

**Visibility cannot be promised.** We do not control Google. Auto-generating
city × service pages is a pattern search engines actively penalise when the
pages are thin. What we can honestly offer is: a fast, well-structured,
genuinely-about-this-business page with correct local markup, and a directory
that is useful to a human. What we must never say is "we will get you to page
one". *An independent analysis of this is commissioned; §7 sequencing depends
on what it concludes.*

**Voice is the one that can damage a customer.** A bad answer in chat is
ignored; a bad answer on the phone loses the job and embarrasses the tradie.
Any version we ship has to fail safe — escalate, take a message, never bluff.
The minimum viable version may well be "answer, take the details, text the
tradie" rather than a full conversation. *Also under independent analysis.*

**Payments need Stripe Connect.** "Receive payments" on the business page means
money moving into the tradie's account, not ours. That is onboarding, identity
verification, payouts and liability — a project, not a feature. It is now on the
critical path for (c), so it gets scheduled rather than deferred indefinitely.

**We are entering two crowded markets.** Job management (ServiceM8, Tradify,
Jobber, Housecall Pro) and directories (hipages, Airtasker, Yelp, Justdial).
The wedge is not being better at either. It is being the only one where the
page, the answers, the diary and the phone are the same system, for a solo
operator, at a price that does not need a sales call.

## 7. Sequence

Ordered by dependency and by what is already built, not by excitement.

| | What | Why here |
|---|---|---|
| **1** | **(c) Presence** | Mostly assembly: Assistant, Bookings, Quotes and Contacts already exist. It turns five modules into one product with an obvious pitch. Nothing else should come first. |
| **2** | **Stripe Connect** | Blocks the payments half of (c), and deposits in Bookings and Quotes. Long lead time because of verification. |
| **3** | **(d) Visibility** | Needs (c) to exist — there is no directory without listings. Slow-burn; start early because it compounds, but never sell it as a guarantee. |
| **4** | **(e) Voice** | Separate technical project with real per-minute cost. Worth doing when there is revenue to justify it and a customer base to pilot with. |
| **5** | **Reviews** | Needs completed jobs to trigger from, so it stays last. |

## 8. How to judge a new idea

Three questions, in order. A no to any of them is a no.

1. **Does it get this tradie more work, or fewer admin evenings?** If it is
   neither, it does not belong here however clever it is.
2. **Does it write to Contacts?** If it keeps its own customer list, it makes
   the system less joined-up, which is the one thing we have.
3. **Can a tradie switch it on without reading anything?** If it needs
   configuration, it needs to be simpler before it needs to be built.

## 9. What this replaces

The "modular B2B SaaS for SMBs" framing in SPEC.md §1 stands as an accurate
description of the *architecture*. This document is the description of the
*business*. Where the two disagree about priority, this one wins.
