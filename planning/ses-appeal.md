# SES production access appeal (issue 76)

**Where it goes:** AWS Console → Support → Your support cases → case
**178755823800807** → *Reply*. A previous request was denied, and after a
denial the API refuses re-submission, so replying to the existing case is the
re-review path. Do not open a new case: a duplicate usually gets closed as one.

**Why now.** The original request was denied when the honest answer to "how do
you handle bounces and complaints?" was "we use the account-level suppression
list". That is the question the form is really asking, and it now has a much
better answer. Everything claimed below was verified against the live account
on 2026-08-28, not asserted from the code.

**Before you send it**, sanity-check these are still true — a claim that has
drifted is worse than one not made:

- `aws sesv2 get-account` → `EnforcementStatus: HEALTHY`
- `aws sesv2 get-email-identity --email-identity makerbay.app` → DKIM SUCCESS
- `aws sesv2 get-email-identity --email-identity send.makerbay.app` → DKIM and
  MAIL FROM both SUCCESS
- `_dmarc.makerbay.app` resolves to the `p=none` record

---

## Paste from here

Hello,

I would like to request reconsideration of production access for Amazon SES in
us-east-1 (account 953146692138).

A previous request from this account was denied. Rather than restate it, I want
to describe what has changed, because the gap in the original request was real:
at that time our only answer on bounces and complaints was the account-level
suppression list. That is no longer the case.

**What the service is.** MakerBay (https://makerbay.app) is a SaaS product used
by solo tradespeople — plumbers, electricians, hairdressers — to run their
bookings, quotes and invoices. Each business's own customers receive mail as a
result of something they or the business just did.

**What we send.** Transactional only, in four categories:

1. Booking confirmations and reminders, to a customer who has just booked an
   appointment on that business's own booking page.
2. Quote and invoice links, sent when a business owner sends a named document
   to a named customer they are already working with.
3. One review invitation after a completed job, to the customer of that job.
4. Notifications to the business owner's own address — a new booking, a new
   enquiry, a quote accepted.

There is no marketing mail, no newsletter, and no mechanism anywhere in the
product for uploading a list or sending in bulk. Every recipient has an
existing transactional relationship with the sending business, and mail is
triggered by a specific action against a specific record.

**How we handle bounces and complaints.** The configuration set
`makerbay-transactional` publishes BOUNCE, COMPLAINT, DELIVERY, REJECT,
RENDERING_FAILURE and DELIVERY_DELAY to EventBridge, and a Lambda consumes
every one of them. Specifically:

- A **permanent** bounce suppresses the address immediately, and nothing
  further is sent to it. A **transient** bounce is recorded but does not
  suppress, because a full mailbox is emptied on Monday and suppressing on it
  would cost a real customer their invoice.
- A **complaint** suppresses the address for optional mail (review requests and
  digests) permanently.
- Suppression is per-business rather than account-wide. Two tradespeople can
  share a customer, and one business's bounce should not silence that address
  for a different business that has its own relationship with them.
- The outcome is written back onto the document that caused the message, so the
  business owner sees "this did not reach them" against the actual quote or
  invoice and can follow up by phone.
- CloudWatch alarms notify us on absolute counts — 5 bounces or 2 complaints in
  an hour — rather than on rates, because at our volume a single complaint is
  already several times the review threshold and a rate alarm would be
  unreadable.
- Our staff console has a suppression lookup and removal tool for support
  requests.

This pipeline was tested end to end against the SES mailbox simulator
(`bounce@`, `complaint@` and `success@simulator.amazonses.com`) and all cases
behave as described.

**How recipients opt out.** Review invitations and digests carry a
`List-Unsubscribe` header together with `List-Unsubscribe-Post:
List-Unsubscribe=One-Click` (RFC 8058), so Gmail and Apple Mail present their
own one-tap control, plus a plain-text link for clients that show neither.
Acting on it is immediate and unconditional — there is no confirmation step,
because a confirmation step is where a one-click unsubscribe silently fails and
the recipient presses the spam button instead. Transactional documents that a
customer is waiting for — a quote, an invoice, a booking confirmation — do not
carry an unsubscribe link, and neither do password-reset codes.

**Authentication and domain separation.**

- `makerbay.app` is verified with DKIM and uses a custom MAIL FROM
  (`mail.makerbay.app`) with the correct MX and SPF records, so SPF and DKIM
  both align.
- `_dmarc.makerbay.app` publishes `v=DMARC1; p=none` with aggregate and
  forensic reporting. It is deliberately at `p=none` while we gather reports,
  and we intend to move to quarantine and then reject.
- Customer-bound mail sends from a separate verified subdomain,
  `send.makerbay.app`, with its own DKIM keys and its own custom MAIL FROM
  (`bounce.send.makerbay.app`). This is deliberate: if a homeowner marks a
  review request as spam, that should affect the reputation of the domain used
  for that traffic, not the domain our password-reset and sign-in codes arrive
  from.
- Amazon Cognito sends through the same SES configuration set, so signup and
  password-reset mail is authenticated and observable like everything else,
  rather than going out from a default shared sender.

**Volume.** Currently under 100 messages a day, and we expect growth in the
hundreds rather than thousands as businesses onboard. We are not asking for a
large quota — the default production limits are far more than we need. The
sandbox is the constraint: it means a real customer of a real business cannot
receive the invoice they are waiting for unless we have separately verified
their address, which is not workable for a product where the recipients are our
customers' customers.

**Enforcement status on the account is HEALTHY**, with no bounce or complaint
history of concern.

I am happy to answer any questions, or to provide sample messages of any of the
four categories above.

Thank you for reconsidering.

## Paste to here

---

## If it is denied again

Ask specifically **which** of the four categories or which control is
insufficient. A second generic denial usually means a reviewer read it as bulk
marketing; the useful reply then is a single concrete example — one booking
confirmation, showing the customer action that triggered it and the timestamps.

Do not open a duplicate case, and do not re-submit through the API: both read
as an attempt to route around the decision.
