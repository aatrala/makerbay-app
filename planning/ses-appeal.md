# SES production access appeal (issue 76)

Paste into AWS Support Center case **178755823800807** (Console →
Support → your cases → reply / reopen). A prior request from this
account was denied; replies to the case are the re-review path.

---

Hello,

Requesting reconsideration of production access for SES in us-east-1
(account 953146692138). Since the original request, the platform has
matured and I can now describe the sending model precisely:

MakerBay (https://makerbay.app) is a SaaS platform for small trade
businesses (plumbers, electricians, cleaners). All mail is strictly
transactional, triggered by a direct action of the recipient or the
account owner:

1. Booking confirmations and reminders - sent to a customer who has
   just booked an appointment themselves on the business's booking
   page, moments earlier.
2. Quote and invoice links - sent when the business owner explicitly
   sends a named document to a named customer they are working with.
3. Review invitations - sent once, after a completed job, to the
   customer of that job. Never bulk, never repeated.
4. Account notifications to workspace owners - new booking or enquiry
   alerts and support-ticket replies, to the owner's own address.

There is no marketing mail, no newsletters, no purchased lists, and no
way for a tenant to upload a list for mass sending - every recipient
has an existing transactional relationship with the sending business.

Bounce and complaint handling: we use the SES account-level
suppression list; delivery errors are surfaced per message inside the
product (the owner sees "email failed" on the exact document), and our
staff console includes a suppression lookup/removal tool. Sending
domain makerbay.app is verified with DKIM.

Volumes are small and will grow slowly: currently under 100
emails/day across all tenants; a 1,000/day quota would cover us for
the foreseeable future.

Website: https://makerbay.app
Mail type: TRANSACTIONAL
Contact: aatrala@gmail.com

Thank you for taking another look.

---

After it is approved, tell Claude and the SES sandbox caveats in the
tracker (issues 49/76) get closed out.
