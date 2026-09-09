# SES appeal, round three (issue 76)

**Context.** The rewritten appeal in `ses-appeal.md` was submitted 2026-09-04
to case 178755823800807. On 2026-09-08 AWS replied with a second denial. The
reply is a template: it names no category, no control and no metric from the
appeal, and points at the AUP, Service Terms and the Best Practices page.

**What that means.** A reviewer who read the appeal and disagreed would have
said what was wrong. A template after a detailed appeal is almost always an
account-level signal rather than a content one: the account is about two
weeks old, has almost no billing history, and the domain is new. None of
that is fixable by writing a better letter.

**Decision.** SES is no longer the critical path for customer mail. The
Resend cutover already decided in `docs/spec-email.md` (2026-08-27) becomes
the unblock. Send the reply below once, then let the case sit; re-open it in
30 to 60 days when the account has a billing history, not before.

**Before sending, run this** (needs `aws login` first, the session is expired):

```bash
aws sesv2 get-account --profile makerbay --region us-east-1 --query "Details.ReviewDetails"
```

Fill in the two placeholders from the MailLog table: pick one real booking
confirmation sent to the mailbox simulator or to a verified address.

---

## Paste from here

Hello,

Thank you for the review. I understand the decision and am not asking you to
reverse it today. I would like to ask one question so that a later request is
worth your time.

The response does not say which part of our sending you are concerned about.
Our previous reply described five categories of transactional mail and the
controls around them. Could you tell me which category, or which control, fell
short? Even a one-line answer, for example "review invitations" or "account
history", would let us fix the right thing rather than guess.

To make the traffic concrete, here is one message end to end:

- A customer opened a business's booking page and booked an appointment at
  [TIMESTAMP].
- The booking confirmation was sent to the address they typed, at
  [TIMESTAMP], SES message ID [MESSAGE-ID].
- It contains the appointment details and the customer's own link to cancel
  or reschedule. Nothing else is ever sent to that address unless the customer
  or the business takes another action.

Every message the product sends follows that shape. There is no list upload
for sending, no campaign feature, and per-business daily caps enforced in code.

If the concern is account age or history rather than the sending itself, I
would rather know that too, so I can come back at the right time instead of
repeating the request.

Thank you.

## Paste to here

---

**Do not:** open a new case, request through the API again, or request in a
second region. All three read as routing around the decision.
