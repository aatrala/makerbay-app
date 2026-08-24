# Requests, Bookings and Quotes — build specification

**Version:** 1.0 · **Date:** 2026-08-24
**Depends on:** Contacts (shipped, core), Assistant (shipped), SES (provisioned)
**Manifests:** `modules/requests|booking|quotes/module.json` are the source of
truth for status, pricing and marketing copy. This document is the build spec.

---

## 0. Why these three together

They are one customer journey, not three products:

```
someone asks something the assistant cannot answer   → Requests
they want a time                                     → Bookings
they want a price for a job                          → Quotes
```

Every one of them attaches to the same person in **Contacts** via
`upsertContact`, and appends to that contact's timeline via
`appendContactEvent`. That is the whole reason Contacts was built first: three
modules with three separate customer lists could never be joined up afterwards.

### Shared plumbing built once

- **Notifications** (`packages/core/src/notify.ts`) — one `sendEmail` used by
  all three, which records the outcome rather than throwing. A notification
  that fails must never lose the booking that caused it.
- **Public token access** — Bookings and Quotes both need a link a customer can
  open without an account. One helper generates and verifies opaque tokens.
- **Widget surface** — Requests renders inside the *existing* assistant bubble.
  We do not ship a second script for a customer's website.

### Explicitly out of scope for v1, and why

| Deferred | Reason |
|---|---|
| **Deposits and payments** on quotes and bookings | Taking a customer's money into *their* account needs Stripe Connect: onboarding, KYC, payouts, and liability we are not ready to carry. Our current Stripe account bills our own subscriptions. Until Connect exists, a quote is accepted and paid for off-platform. |
| **Scheduled reminders** | Needs EventBridge Scheduler plus SES production access. Bookings v1 confirms on creation; reminders follow once we are out of the sandbox. |
| **Calendar sync** | Google Calendar two-way sync is a per-tenant OAuth project of its own. |
| **Recurring bookings, staff/resource assignment** | Single-resource businesses first. Multi-staff is a schema change we should make deliberately, not by accident. |

These are written into the module manifests' FAQs so we do not promise them.

---

## 1. Requests

**Route prefix:** `/v1/requests/*` (authenticated), `/v1/public/requests/*`
**Metered:** `request.created`, `notification.sent`

### 1.1 What it is

An unanswered question should not end the conversation. Requests captures the
customer's details in the same chat window, emails the owner, and files the
thread in a dashboard inbox.

Three kinds, one table, because they differ only in wording and in what
triggers them:

- `handoff` — the assistant could not answer, and offered a person.
- `lead` — the customer asked to be contacted about buying something.
- `feedback` — a comment, complaint or thumbs-down worth reading.

### 1.2 Data

`Requests` table, pk `tenantId`, sk `requestId` (ULID, so newest sorts last).
GSI `byStatus` on `tenantId` + `statusCreated` (`open#<iso>`), because the
inbox almost always wants open items only.

```
tenantId, requestId, kind, status: new | open | closed
contactId          — always set; upsertContact runs before the write
name, email, phone — as given; also merged into the contact
subject, message
sessionId          — the assistant conversation it came from, when it had one
transcript[]       — the last few turns, so the owner has context
replies[]          — { at, byUserId, text, emailed: boolean }
source             — widget | hosted | api
createdAt, updatedAt, closedAt
```

### 1.3 API

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /v1/public/requests` | publishable key or slug | Create from the widget |
| `GET /v1/requests` | Cognito | Inbox, `?status=` and `?kind=` |
| `GET /v1/requests/{id}` | Cognito | One thread |
| `PATCH /v1/requests/{id}` | Cognito | Change status |
| `POST /v1/requests/{id}/replies` | Cognito | Reply, optionally emailed |
| `GET/PUT /v1/requests/config` | Cognito | What to collect, notify address |

### 1.4 Rules

- **A request always has a contact.** `upsertContact` first, then the request
  row, then `appendContactEvent`. Never the other way round: a request whose
  contact write failed is an orphan nobody will find.
- **Rate limited by plan.** Free plans get a monthly cap so an abandoned widget
  on a busy site cannot generate unbounded email.
- **Notification failure is not request failure.** The customer sees success if
  their request was stored. The owner sees a warning in the inbox instead.
- **The widget collects the minimum.** Email *or* phone, plus the message.
  Every extra field costs completions.

### 1.5 Acceptance

The assistant fails to answer → the widget offers a person → the customer
leaves an email and a message → the owner gets an email → the request is in the
inbox with the conversation attached → the customer exists in Contacts with a
timeline entry → `request.created` lands in `Usage`.

---

## 2. Bookings

**Route prefix:** `/v1/booking/*`, `/v1/public/booking/*`
**Metered:** `booking.created`, `reminder.sent`

### 2.1 What it is

Publish what you offer and when you work; let customers book themselves in.
Single resource in v1: one calendar, one business, several services.

### 2.2 Data

`BookingServices` — pk `tenantId`, sk `serviceId`:
```
name, description, durationMinutes, bufferMinutes, priceCents?, active
```

`BookingConfig` — pk `tenantId`:
```
timezone            — IANA name; every slot is computed in it
hours               — { mon: [{ from: '09:00', to: '17:00' }], … }
leadTimeHours       — how soon someone may book (default 12)
horizonDays         — how far ahead (default 60)
closures[]          — { date, reason } for holidays
notifyEmail
```

`Bookings` — pk `tenantId`, sk `bookingId`. GSI `byStart` on `tenantId` +
`startsAt`, which is what both the day view and the conflict check need.
```
contactId, serviceId, serviceName
startsAt, endsAt      — ISO instants, always UTC in storage
status: confirmed | cancelled | completed | noshow
name, email, phone, note
source, createdAt, cancelledAt, cancelToken
```

### 2.3 Slot computation

Pure function, `slotsFor(config, service, bookings, dayISO)`, unit-testable
without AWS:

1. Take the weekday's opening windows in the business timezone.
2. Step by `durationMinutes`, discarding anything inside a closure.
3. Drop slots that overlap an existing non-cancelled booking, **including its
   buffer on both sides**.
4. Drop slots earlier than `now + leadTimeHours`.

Storage is UTC and display is the business timezone. Mixing those is how
booking systems produce appointments an hour out twice a year, so the
conversion happens in exactly one place.

### 2.4 API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /v1/public/booking/services` | key or slug | What can be booked |
| `GET /v1/public/booking/slots` | key or slug | Free slots for a service and date |
| `POST /v1/public/booking` | key or slug | Take a booking |
| `GET /v1/public/booking/{token}` | token | View or cancel, no account |
| `GET/POST/PATCH/DELETE /v1/booking/services` | Cognito | Manage services |
| `GET/PUT /v1/booking/config` | Cognito | Hours, timezone, closures |
| `GET /v1/booking/bookings` | Cognito | Diary, `?from=&to=` |
| `PATCH /v1/booking/bookings/{id}` | Cognito | Cancel or complete |

### 2.5 Rules

- **Double booking is checked at write time**, not only when listing slots. Two
  customers can load the same slot list a second apart; the loser gets a clear
  "that time has just gone" rather than a silent overwrite.
- **Cancellation needs no account.** The confirmation email carries an opaque
  token link. Guessable ids would let anyone cancel a stranger's appointment.
- **Timezone lives in config, never in the browser.** A customer booking from
  another country must still get the business's hours.

### 2.6 Acceptance

Owner sets hours and one service → customer opens the hosted page, sees only
genuinely free slots → books → both sides get an email → the diary shows it →
the contact has it on their timeline → booking the same slot again is refused.

---

## 3. Quotes

**Route prefix:** `/v1/quotes/*`, `/v1/public/quotes/*`
**Metered:** `quote.sent`, `quote.accepted`

### 3.1 What it is

A job enquiry arrives through Requests. The tradie prices it from a saved list
of line items and sends a link. The customer opens it on their phone and
accepts. Quoting only — see §0 for why invoicing is not here.

### 3.2 Data

`PriceItems` — pk `tenantId`, sk `itemId`:
```
description, unit ('hour' | 'item' | 'day' | 'm2' | …), unitCents, active
```

`Quotes` — pk `tenantId`, sk `quoteId`:
```
contactId, requestId?      — where the job came from
number                     — human-facing, per tenant, monotonic
lines[]                    — { description, unit, quantity, unitCents }
subtotalCents, taxRate, taxCents, totalCents
currency                   — from the workspace, default AUD
notes, terms
status: draft | sent | accepted | declined | expired
publicToken, validUntil
sentAt, acceptedAt, declinedAt
```

### 3.3 Money

- Integer minor units everywhere. No floats touch a price.
- Line total = `round(quantity × unitCents)`; subtotal is the sum of those, so
  what the customer adds up by hand matches what we charge.
- Tax is a single workspace-level rate in v1 (GST-style). Per-line tax
  treatment is a real requirement in some markets and a schema change we should
  make deliberately.
- **An accepted quote is immutable.** Editing one after acceptance would change
  what somebody agreed to. Editing produces a new revision instead.

### 3.4 API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET/POST/PATCH/DELETE /v1/quotes/items` | Cognito | The saved price list |
| `POST /v1/quotes` | Cognito | Create a draft |
| `GET /v1/quotes` | Cognito | List, `?status=` |
| `GET /v1/quotes/{id}` | Cognito | One quote |
| `PATCH /v1/quotes/{id}` | Cognito | Edit a draft |
| `POST /v1/quotes/{id}/send` | Cognito | Email it, status → sent |
| `GET /v1/public/quotes/{token}` | token | Customer view |
| `POST /v1/public/quotes/{token}/respond` | token | Accept or decline |

### 3.5 Rules

- **The token is the credential.** Long, random, single-purpose. It grants view
  and respond on one quote and nothing else.
- **Expiry is real.** Past `validUntil`, the public page shows expired and
  refuses to accept. A price from four months ago is not a price.
- **Acceptance is recorded once.** A second accept is a no-op returning the
  same result, because customers double-tap.

### 3.6 Acceptance

A request becomes a quote in one click with the customer already attached →
lines come from the saved price list → sending emails a link → the customer
opens it on a phone and accepts → the tradie is emailed → status and timeline
both update → accepting twice changes nothing → an expired quote cannot be
accepted at all.

---

## 4. Cross-cutting

### 4.1 Entitlements

All three are billable modules with an `entitlementKey`, off until switched on.
Free-tier caps (`requests` 50/month, `booking` 50/month, `quotes` 20/month)
exist to bound cost, not to frustrate: exceeding one returns a clear message
naming the limit, never a silent failure.

### 4.2 Email in the sandbox

SES production access is still pending, so every send can fail with
`MessageRejected` for unverified recipients. Therefore:

- sending is **never** in the critical path of a write;
- failures are recorded on the row (`notifyError`) and surfaced in the
  dashboard, so the owner knows to follow up by hand;
- the dashboard says plainly when email is not yet enabled.

### 4.3 Tenant isolation

Unchanged and non-negotiable: every table is partitioned by `tenantId`, every
public route resolves the tenant from a publishable key or slug server-side,
and no client-supplied `tenantId` is ever trusted.

### 4.4 Testing

The pure logic in these modules — slot computation, money arithmetic, token
generation, status transitions — is exactly the kind that should be unit
tested, and it can be tested without AWS. This is the natural point to
introduce Vitest.

---

## Addendum 2026-08-24: reminders, revisions, invoices (shipped)

### Booking reminders
- One-off EventBridge Scheduler schedule per booking, name `rem-{bookingId}`,
  created at booking time (`ActionAfterCompletion: DELETE` so fired schedules
  clean themselves up), deleted best-effort on cancel from either side.
- Timing is pure and tested (`reminder-time.ts`): more than 26h out → 24h
  before; more than 3h out → 2h before; else no reminder.
- The reminder Lambda re-reads the booking and sends only if it is still
  `confirmed`, has an email, and is still in the future. The schedule is a
  wake-up call, not the source of truth. Metric: `reminder.sent`.
- On completion the booking Lambda emits `booking.completed` on the bus; the
  reviews Lambda owns what happens next (see SPEC.md §5).

### Quote revisions
- `POST /v1/quotes/{id}/revise` on any non-draft quote: a fresh draft with a
  new number and token, `revisionOf` back-reference. A `sent` original flips
  to `superseded` and its public page points forward to the new quote; a
  settled original (accepted/declined/expired) keeps its status - history
  never changes.

### Simple invoices (in the Quotes module)
- Born from an accepted quote only (`POST /v1/quotes/{id}/invoice`); lines
  and totals are copied, never recomputed - the customer already agreed.
- Own atomic number series (`INV-0001`); table `makerbay-invoices`.
- Statuses `draft → sent → paid | void`. Paid is immutable except void.
- Public themed page at `chat.makerbay.app/invoice?slug=&token=`, printable
  (three themes: classic, compact, bold; picked in Quotes settings alongside
  `paymentInstructions` and `dueDays`).
- Deliberately not bookkeeping: no ledgers, no reconciliation, no tax
  accounting. The public roadmap wording changed from "no invoicing" to
  "no bookkeeping/tax accounting" the same day this shipped.
- Metrics: `invoice.sent`, `invoice.paid`.
