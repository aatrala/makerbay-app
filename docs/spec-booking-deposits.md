# Booking deposits (issue 73)

Approved 2026-08-26 after an agent consult; built the same day. Founder
comments on the live build.

## Shape

A service can carry a fixed deposit (`depositCents` on the service row,
$1..$5000; percent deliberately rejected - services may have no price,
and trades think "$50 to secure the slot"). When set AND the tenant's
`payoutsEnabled` is true, the public booking create writes the row as
`pending_payment` with a **35-minute hold**, skips every confirm side
effect, and the hosted page redirects to Stripe Checkout via the
existing `POST /v1/public/payments/session` with `kind:
'booking_deposit'` and the booking's cancelToken. The session's
`expires_at` is 30 minutes (Stripe's floor) - **5 minutes shorter than
the hold**, so a completed payment can never land on a freed slot.
That gap is the whole double-booking defence; do not shrink it.

The signature-verified webhook emits `payment.received` on the bus;
the booking Lambda (new second target on PaymentReceivedRule) flips
`pending_payment` → `confirmed` under a ConditionExpression, stamps
`depositPaidAt`/`paymentId`, and only then fires the confirmation
emails/reminder/usage (extracted as `confirmSideEffects`). A payment
for a lapsed hold fails the condition, logs loudly and emails the
owner to refund from the Payments screen.

Abandoned holds lapse lazily: `blocking()` ignores a pending row past
its hold, and `countBookingsThisMonth` never counts one - no cron, no
extra webhook events, no new tables.

## Decisions of record

- Created-pending-payment, not pay-before-created: the pending row IS
  the slot hold, reusing every conflict check and token path.
- No automatic refunds: self-cancel frees the slot; the deposit stays
  until the owner refunds it from Payments (that is the point of a
  deposit). Copy says "refundable at {business}'s discretion".
- Deposits are allowed on the free tier - Stripe onboarding is the
  commitment filter, and the marginal cost is zero.
- Currency comes from quotesConfig (one platform-wide stance).
- pending_payment is invisible in the Diary; a confirmed booking shows
  a "$X paid" chip.
- Owner disabling payments later: deposit config goes dormant (public
  services stop advertising it, creates fall through to instant
  confirm). Nothing breaks; re-enabling resurrects it.
- v1 anti-goal: the deposit is NOT credited against a later invoice -
  the owner nets it off manually. Ledger wiring is a separate consult.

## Acceptance (demo tenant)

Set a $50 deposit on one service → book it publicly → pay → booking
confirmed with the paid chip; abandon → slot frees at 35 min; refund
works from Payments.
