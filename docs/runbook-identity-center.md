# Identity Center runbook (issue 154)

Status: written 2026-08-30. Founder console work: ~30 minutes (Part A).
CLI/CDK follow-up is Claude's (Parts B and C, ~20 minutes after A).

## Why, verified against the live account 2026-08-30

- Every CLI call and deploy today runs as **the root user** - STS confirms
  `arn:aws:iam::953146692138:root`. There are zero IAM users. A compromised
  laptop or browser session is the whole account, unrecoverable.
- **No CloudTrail trail exists.** Only the console's 90-day event history;
  nothing durable, nothing to alert from.
- The saving graces, also verified: root has **no access keys** and **MFA is
  enabled**. So the fix is additive - nothing dangerous to revoke first.
- Bonus fix: Identity Center sessions can last 12 hours. The current
  short-lived `aws login` session is what keeps expiring mid-deploy
  (it stranded issue 118 phase 2 for a day).

## Part A - founder, in the console (~30 min, in this order)

1. **Create the organization.** Console → AWS Organizations → Create
   organization (all features). Click the verification link that lands at
   the root email. This makes 953146692138 the management account - fine
   for a solo founder; moving workloads to a member account is a separate,
   much later project and NOT part of this issue.
2. **Enable IAM Identity Center** - console → IAM Identity Center →
   Enable, choosing **"Enable with AWS Organizations"** (the account-only
   instance cannot grant AWS account access, which is the whole point).
   Region: **us-east-1** - the home region is sticky, so take the one
   everything else already lives in.
3. Optional but nice: Settings → customize the access portal URL to
   `makerbay.awsapps.com/start`.
4. **Create your user.** Users → Add user: username `aatrala`, email
   aatrala@gmail.com. Accept the invitation email, set a password, and
   register MFA - a passkey if the machine supports it, plus an
   authenticator app as backup. Then Settings → Authentication → require
   MFA **every time** (not "only when context changes").
5. **Permission sets.** Permission sets → Create:
   - `AdministratorAccess` (predefined) - **session duration 12 hours**.
     The 12 hours is the mid-deploy-expiry fix; do not leave the 1-hour
     default.
   - Optional: `ReadOnlyAccess` (predefined, also 12 h) for
     look-don't-touch days.
6. **Assign.** AWS accounts → select 953146692138 → Assign users →
   `aatrala` → both permission sets.
7. **Unlock billing for roles.** Account page (as root) → "IAM user and
   role access to Billing information" → Activate. Without this, Cost
   Explorer - which CLAUDE.md says to check after infra changes - is
   root-only forever, defeating the purpose.

That is the end of the console work. Root is not "disabled" - it keeps its
MFA and stays the recovery path and the owner of the few tasks AWS reserves
to it (account closure, some billing/tax/support settings). It simply stops
being the daily driver, and Part C makes any future root sign-in page you.

## Part B - Claude, CLI switchover (~10 min, after A)

1. `aws configure sso`: sso-session `makerbay`, start URL from step A3,
   SSO region us-east-1, account 953146692138, role AdministratorAccess,
   profile name **`makerbay`** - the same name as today, so every script,
   memory note and CLAUDE.md instruction keeps working unchanged. boto3,
   the JS SDK, the CDK CLI and the AWS MCP all support SSO profiles.
2. Sign in becomes `aws sso login --profile makerbay`, once per 12 hours,
   replacing `aws login`.
3. Verify, in order: `aws sts get-caller-identity` shows
   `assumed-role/AWSReservedSSO_AdministratorAccess_...` (NOT root);
   `cdk diff` runs clean; `node scripts/publish-embed.mjs --check` reads
   the bucket; one `verify-share-flow.mjs` pass.

## Part C - Claude, CDK hardening (~10 min, one commit)

Small additions to the stack (fits easily at 413/500):

1. **A multi-region CloudTrail trail** for management events, logging to a
   dedicated bucket with a **366-day lifecycle** - the privacy policy's
   twelve-month retention promise applied to our own audit log, not just
   Lambda logs.
2. **Root-activity alarm:** an EventBridge rule on the default bus for
   console sign-ins where `userIdentity.type = Root`, targeting the
   existing alerts SNS topic. After Part A, a root sign-in should be rare
   enough that every one deserves an email. (The alerts subscription is
   the same one awaiting the confirmation click - issue 150.3 - so that
   click gates this alarm too.)
3. **GitHub OIDC provider + read-only role** for CI's dormant embed drift
   check (s3:GetObject/HeadObject on the embed bucket only), and set
   `CI_AWS_ROLE_ARN` in the repo - which switches on the last dormant CI
   step from issue 152.

## Gotchas, so nobody rediscovers them

- The Identity Center home region cannot be changed without a reinstall -
  hence us-east-1 on day one.
- Creating the organization is effectively permanent for this account
  (a management account cannot simply leave its own org). Accepted.
- Keep the root email mailbox and the root MFA device safe - root remains
  the recovery path for everything above it.
- If a deploy ever says the SSO token expired: `aws sso login --profile
  makerbay` and re-run; there is no long-lived credential anywhere in the
  new setup, which is the point.

## Done means

`aws sts get-caller-identity` from a fresh shell shows the SSO role; a
full `cdk deploy` completes inside one session with no mid-flight expiry;
CloudTrail shows the trail Logging; a deliberate root console sign-in
produces the alert email; CI runs the embed drift check.
