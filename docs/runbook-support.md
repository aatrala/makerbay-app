# Runbook: supporting customers from the staff console

The console lives at https://admin.makerbay.app. It talks to admin-api on its
own gateway and its own Lambda - admin routes do not exist on the customer
API. Every mutation is audited to the AdminAudit table, which the Lambda can
only append to.

## Staff accounts (bootstrap and recovery)

Staff sign in against the SEPARATE staff Cognito pool (TOTP MFA, no
self-service recovery - `accountRecovery: NONE` is deliberate). Creating a
staff login therefore always happens from the AWS CLI, and this is also the
ONLY recovery path if a staff member loses their authenticator.

1. Find the pool and table (once):

```bash
aws cloudformation describe-stack-resources --stack-name Makerbay --profile makerbay --query "StackResources[?contains(LogicalResourceId,'StaffPool') || contains(LogicalResourceId,'Staff')].[LogicalResourceId,PhysicalResourceId]" --output table
```

2. Create the Cognito user (they get a temp password by email and set a real
   one + TOTP at first sign-in):

```bash
aws cognito-idp admin-create-user --user-pool-id <STAFF_POOL_ID> --username staff@example.com --user-attributes Name=email,Value=staff@example.com Name=email_verified,Value=true --desired-delivery-mediums EMAIL --profile makerbay
```

3. Add the staff-directory row - the authorizer checks this table on every
   request, so a Cognito user without a row gets nothing:

```bash
aws dynamodb put-item --table-name makerbay-staff --item '{"staffSub":{"S":"<sub from admin-create-user output>"},"email":{"S":"staff@example.com"},"role":{"S":"support"},"status":{"S":"active"},"createdAt":{"S":"<now ISO>"}}' --profile makerbay
```

Off-boarding is the reverse order: set `status` to `disabled` in the table
first (takes effect on their next request), then disable the Cognito user.

Lost or expired temp password (the account exists but sign-in fails):

```bash
aws cognito-idp admin-create-user --user-pool-id us-east-1_KX5f3Cw0g --username staff@example.com --message-action RESEND --profile makerbay
```

Lost authenticator: there is no self-service path on purpose. Verify the
person out-of-band, then:

```bash
aws cognito-idp admin-set-user-mfa-preference --user-pool-id <STAFF_POOL_ID> --username staff@example.com --software-token-mfa-settings Enabled=false,PreferredMfa=false --profile makerbay
```

and have them re-enrol at next sign-in.

## Triage: always start at find-by-email

Every ticket arrives as an email address. Workspaces page → "Find by email"
→ lands on the workspace 360. The lookup itself is audited.

## Per-ticket first looks

| Ticket | First look |
|---|---|
| "Can't log in" | 360 → People → Send password reset (Cognito emails them a code; staff never see a password) |
| "Billing is wrong" | 360 → Account → Stripe webhook row. No events or wrong mode = webhook misconfigured. Stripe customer id links the Dashboard |
| "Payments/payouts stuck" | 360 → Get paid (Connect). `onboarding incomplete` = they never finished Stripe onboarding; otherwise investigate in the Stripe Connect dashboard with the acct id |
| "Emails not arriving" | Email page → test-send to yourself proves platform SES. If platform is fine, check the SES suppression list in the AWS console (P1 will surface it) |
| "Hit my cap" | 360 → Usage + Grant a module (reason + expiry required) |
| "Page not public / domain broken" | 360 → Public page row (published, domain, domain status). Deeper: ACM + CloudFront consoles |
| "AI answered wrong" | Ask the customer for the conversation for now (viewer is P1) |
| Abuse / fraud | 360 → Suspend workspace (reason required). Public pages vanish immediately; dashboard and API die as authorizer caches expire (allow a few minutes). Reinstate the same way |
| Account deletion (privacy) | Scripted export/delete is P1; today it is a hand job - record an audit note (grant/revoke with reason works as a note of record) |

## Rules

- Anything mutated OUTSIDE the console (raw DynamoDB, Stripe Dashboard,
  Cognito console) gets an audit note in the console afterwards.
- Refunds and subscription cancellations live in the Stripe Dashboard, on
  purpose. Log search lives in CloudWatch. The console links the ids.
- Suspension is enforced in two places: `getTenantBySlug` (all public
  surfaces) and the customer authorizer (all authenticated calls). If you
  suspend someone mid-session they keep the dashboard until the authorizer
  cache expires - that is expected.
