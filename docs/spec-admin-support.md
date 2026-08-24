# Spec: Admin console as a support tool - gap analysis

Status: **PROPOSED - awaiting founder approval.** Produced 2026-08-24 by a
second Fable 5 architect from the actual admin/, packages/admin-api and core
code. Answers: "can I support my users from the admin portal?"

## Honest verdict

The foundation (separate staff pool + MFA, live staff-directory check on
every request, append-only audit the Lambda can only PutItem to, grants with
reasons and expiry) is better than most seed-stage admin panels - and the
"customer hit a cap" flow works end-to-end today. But of the ten most likely
support tickets, roughly ONE is fully handleable in the console; you cannot
find a customer by email address; there is no kill switch; and the way to
create your own staff login is not written down anywhere. ~3 days of P0 work
turns it from a grants tool into a support tool.

## What exists today (verified)

- Console: SignIn (SRP + TOTP + temp-password flow), Tenants list
  (scan + client search), TenantDetail (plan/status/Stripe ids, effective
  entitlements, grants create/revoke - Stripe grants correctly refused),
  Email test-send (to the staff member's own address only).
- API: 6 routes; all mutations audited to AdminAudit (PutItem-only role).
- Exists in tables but NOT surfaced: webhook health (lastWebhookAt/Type/
  Live), Stripe Connect state, owner emails, audit reader, suspension
  (status field is decorative - nothing sets or enforces it), SES
  suppression, privacy export/delete, conversations.

## Ten-ticket test

Fully works today: "hit my message cap" (usage + manual grant). Partial:
emails not sending (platform test only), payout stuck (data exists,
unreturned), wrong AI answer (tenant sees it, staff can't). Requires raw
DynamoDB/AWS console today: can't log in, page not in Google, account
deletion (privacy), abuse kill switch, "what changed", suppression lookups.

## Gap spec (mutations always audited)

- **G1 (P0, ~2h)** Staff bootstrap runbook + script - admin-create-user +
  Staff-table row. Without it there is no console; also the only recovery
  path (accountRecovery: NONE).
- **G2 (P0, ~0.5d)** Tenant 360 completion: return webhook health, Connect
  trio, owner users, per-module state (page published/domain status, source
  count, voice number) from tables the Lambda can already read.
- **G3 (P0, ~0.5d)** User lookup by email (byEmail GSI or Cognito ListUsers)
  + audited "send password reset". Every ticket arrives as an email address.
- **G4 (P0, ~1d)** Suspend/unsuspend with ENFORCEMENT in the customer
  authorizer and public routes (the real work); reason required, audited.
  This is the abuse kill switch.
- **G5 (P1, ~1d)** SES suppression visibility + audited removal.
- **G6 (P1, ~1d)** Read-only conversation viewer (thumbs-down flagged).
  Do NOT build impersonation - read-only "view as tenant" via admin-api
  preserves the pool-separation guarantee.
- **G7 (P1, ~1-2d)** Scripted, audited privacy export/delete (all
  tenant-keyed tables → S3 JSON → delete; Cognito + Stripe by hand).
- **G8 (P1, ~2h)** Audit log reader (month-partitioned Query + page).

Explicitly NOT building: refunds/cancellations (Stripe Dashboard), payout
investigation (Connect dashboard), log search (CloudWatch), MFA resets
(Cognito console). The console links out with the right ids pre-surfaced.

## Runbook (docs/runbook-support.md, to write with P0)

Access + staff account creation/recovery; triage always starts at
find-by-email → Tenant 360; per-ticket first looks (billing → webhook health
+ Stripe id; email → test-send → suppression → SES console; login → reset;
caps → grant with expiry; payouts → Connect dashboard; AI → conversation
viewer; page/domain → presence state → ACM/CloudFront); escalation rule:
anything mutated outside the console gets an audit note.

## Priorities

P0 before real customers (~2-3 days): G1-G4 + runbook.
P1 first 100 customers (~4-5 days): G5-G8.
P2 later: feature flags/kill switches per module, console deletion, staff
role differentiation (staffRole is plumbed but unchecked), replace scans.
