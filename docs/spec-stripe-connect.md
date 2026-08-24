# Spec: Payments (Stripe Connect)

Status: **SHIPPED 2026-08-24** as `modules/payments` (payments-api 1.0.0).
As-built deltas from the plan below:

- Invoice payment + quote deposits shipped; **booking deposits deferred**
  (they need pending-booking semantics; revisit with demand).
- Stripe events reach the module via the EXISTING billing webhook (one
  endpoint, one signing secret): billing-webhook verifies the signature and
  forwards `checkout.session.completed` / `account.updated` onto the bus as
  `makerbay.stripe` events; an EventBridge rule targets the payments Lambda.
  Fulfilment emits `payment.received`, which the quotes Lambda consumes to
  mark invoices paid / stamp quote deposits.
- The pay button is gated by `tenant.payoutsEnabled` everywhere public - no
  Stripe connected, no button.
- Operational requirements on the Stripe dashboard: (1) add
  `checkout.session.completed` and `account.updated` to the existing webhook
  endpoint's events; (2) if the platform key is a RESTRICTED key (rk_), it
  needs Accounts Write, Account Links Write, Checkout Sessions Write,
  Payment Intents Write and Refunds Write scopes - Connect account creation
  fails cleanly with `more_permissions_required` until then.

The original plan, kept for the reasoning:

## 1. What this is

Money moving from a customer to a tradie, through MakerBay, in the three
moments the product already creates:

1. **Deposit on an accepted quote** - "accept and pay the $150 deposit".
2. **Deposit at booking time** - a booking that costs money to no-show.
3. **Invoice payment** - the invoice page grows a real Pay button.

It is deliberately NOT: a wallet, payouts scheduling, terminal/card-present,
subscriptions for tenants' customers, or anything that makes MakerBay hold
funds. Stripe holds and moves the money; we orchestrate.

## 2. Design decisions (settled)

- **Connect account type: Express.** Standard pushes too much dashboard on a
  tradie; Custom makes us liable for onboarding UX and compliance. Express
  gives Stripe-hosted onboarding, Stripe-owned KYC, and a minimal dashboard.
- **Charge type: destination charges** with `on_behalf_of`, so the platform
  account is the merchant of record for the fee line only and the connected
  account is the settlement merchant. Funds route directly; refunds happen on
  the platform charge.
- **Application fee**: start at 0 while Connect proves itself, structured so a
  percentage can be turned on later without an API change (`application_fee_amount`
  computed server-side from config, default 0).
- **Currency**: the tenant's quote/invoice currency (AUD default). No FX.
- **No card data ever touches us**: Stripe Checkout Sessions, not Elements, in
  v1. One redirect, Stripe-hosted page, `success_url` back to the public page
  with a status query. PCI scope stays SAQ-A.
- **Secrets**: the platform Stripe key already lives in `makerbay/stripe`
  (Secrets Manager, runtime-resolved). Connect adds no new secret.

## 3. Data

New table `makerbay-payments` (`tenantId`, `paymentId` ULID):

```
tenantId, paymentId
kind:        'quote_deposit' | 'booking_deposit' | 'invoice'
refId:       quoteId | bookingId | invoiceId
amountCents, currency
status:      'pending' | 'paid' | 'failed' | 'refunded'
stripeSessionId, stripePaymentIntentId
createdAt, paidAt?
```

Tenant connect state on the tenant row (via core, never raw):
`stripeAccountId`, `payoutsEnabled: boolean`, `connectOnboardedAt`.

## 4. API surface

Owner (authorized):
- `POST /v1/payments/connect` - create the Express account if missing, return
  a fresh Account Link URL (onboarding or update, decided by account state).
- `GET  /v1/payments/connect` - onboarding/payout status, refreshed from
  Stripe on read (accounts change state out-of-band).
- `GET  /v1/payments` - list payments with status.
- `POST /v1/payments/{id}/refund` - full refund only in v1.

Config additions (owned by the module that shows the button):
- Quotes config: `depositPercent` (0 = off) or `depositCents`.
- Booking service row: `depositCents?` (per service, 0/absent = off).

Public:
- `POST /v1/public/payments/session` - given `{slug, kind, token}` (the quote
  token, booking cancel token, or invoice token - the same capability tokens
  the pages already use), validates state (quote accepted, booking confirmed,
  invoice unpaid), creates a Checkout Session against the tenant's connected
  account, records a pending payment row, returns the redirect URL.

Webhook (no authorizer; signature-verified like billing):
- `POST /v1/public/payments/webhook` - `checkout.session.completed` marks the
  payment row paid, then tells the owning module:
  - invoice → `patchInvoice(status: 'paid')` (same path as manual mark-paid)
  - quote deposit → contact event + `payment.received` metric
  - booking deposit → contact event + metric
  `account.updated` refreshes `payoutsEnabled` on the tenant.

Events: `payment.received` usage metric `{kind, amountCents}`; domain event
`invoice.paid` already exists and fires from the shared patch path.

## 5. Surfaces

- Quote public page: after accept, if a deposit is configured and unpaid -
  "Pay the deposit" button → Checkout redirect → back with a paid banner.
- Invoice public page: "Pay this invoice" button when unpaid and the tenant
  is onboarded; the themed page shows Paid the moment the webhook lands.
- Booking flow: if the service has a deposit, the confirm step becomes
  "Confirm and pay" and the booking is only written after
  `checkout.session.completed` (pending rows expire; a slot is never held by
  an unpaid intent for more than the session lifetime).
- Dashboard: a Payments screen (list + refund) and a "Get paid" onboarding
  card that deep-links to the Account Link.

## 6. Failure honesty

- Not onboarded → public pages simply do not show pay buttons (never a dead
  button, same rule as the presence page).
- Session creation failure → the page says payment is unavailable and the
  accept/booking still works without it. Money is an enhancement, never a
  gate on the core flow, until the tenant explicitly configures a mandatory
  deposit for bookings.
- Webhook is the source of truth; the success redirect alone never marks
  anything paid.

## 7. Acceptance

1. A tenant completes Express onboarding from the dashboard and
   `payoutsEnabled` flips true.
2. An accepted quote with a 20% deposit shows Pay; test-mode payment marks
   the payment row paid and appends the contact event.
3. An unpaid invoice's public page takes a test payment and flips the page
   and dashboard to paid without any manual step.
4. Refund from the dashboard refunds in Stripe and marks the row.
5. A tenant with payouts disabled sees no pay buttons anywhere public.

## 8. Out of scope for v1

Partial refunds, saved cards, payment plans, per-line deposits, surcharging,
Tap to Pay, and any fee-on-top pricing. Each is a deliberate later decision.
