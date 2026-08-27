# Spec: transactional email (issue 94)

Status: **DESIGNED 2026-08-27, awaiting founder sign-off.** Copy is a separate
approval and lives at the artifact linked below. Every structural claim here
was verified against the repo, not inferred.

**The copy for all twenty existing emails plus the twenty-five missing ones is
published for review separately.** This document is the system: templates,
sender identity, provider, deliverability, Cognito, bounces and testing.

## What exists today

Twenty `sendEmail` call sites across eight modules, all through one 40-line
sender in `packages/core/src/notify.ts`. That single funnel is the reason
everything below is affordable, and it was a good decision paying off.

**`sendEmail` has no HTML path at all.** It sets `Content.Simple.Body.Text`
and nothing else; grep the file for `Html` and you get zero hits. Every email
MakerBay sends is plain text.

Recipient split, which drives the whole design:

| Class | Sites | Identity it must wear |
|---|---|---|
| **Customer** | 9 (booking confirm, owner-cancelled, reminder, quote sent, invoice sent, 3 review asks, reply-to-enquirer) | The **tradesperson's** business |
| **Owner** | 8 (new booking, lapsed deposit, customer-cancelled, quote accept/decline, deposit paid, new request, digest, missed call) | MakerBay |
| **Staff** | 2 (ticket opened, ticket reply) | Internal |
| **Cognito** | 2 (signup verification, password reset) | MakerBay, and currently neither |

## The five findings that shape this

All verified in the code.

1. **Every customer-bound email is sent by MakerBay** (issue 103). `EmailInput`
   has no `from` field; `FROM()` hardcodes `process.env.EMAIL_FROM ??
   'hello@makerbay.app'` and every Lambda sets the same value. A homeowner who
   booked Southside Plumbing gets a confirmation whose From line reads
   *MakerBay*, signed by a business they have heard of. That is the shape of a
   phishing email, and the From line is what a phone shows in the inbox list.
   Reputation is shared across every tenant, so one annoyed customer marking
   spam degrades delivery for all of them.
2. **Replies are thrown away** (issue 106). Only 5 of 20 sends set `replyTo`,
   and only **one** of those five is customer-bound
   (`quotes/handler.ts:499`). Grep the stack for `ReceiptRule`, `MxRecord` or
   `new route53.MxRecord`: zero hits. There is no inbound mail on
   makerbay.app. Replies to invoices and booking confirmations are being
   discarded, in production, today.
3. **Bounces and complaints are discarded** (issue 107). `EmailConfigSet`
   (`makerbay-stack.ts:200`) sets `tlsPolicy` and `reputationMetrics` and
   nothing else; there are zero event destinations in the stack. So
   `notifyError` (`quotes/api/src/db.ts:50`) records only synchronous API
   failure, and the `emailFailedChip` in `quotes/web/src/index.tsx:102` can
   never fire for a real bounce.
4. **No DMARC** (issue 108). SPF, DKIM and a custom MAIL FROM are all written
   correctly by CDK. `_dmarc` appears nowhere.
5. **Cognito is unconfigured** (issue 104). Neither pool passes an `email:`
   prop, so both use `COGNITO_DEFAULT`: sent from
   `no-reply@verificationemail.com`, a domain MakerBay does not own, capped at
   **50 emails per day across the whole AWS account**, shared between the
   customer and staff pools, non-adjustable, resetting 09:00 UTC.

Plus one latent hazard: **`TenantRow.name` reaches `subject:` unescaped at
eight sites** (issue 109). Safe under `Content.Simple`; header injection the
moment we move to `Raw`, which `List-Unsubscribe` requires.

## Decisions

1. **Add sender identity to `EmailInput`.** Owner-bound stays `MakerBay
   <hello@makerbay.app>`. Customer-bound becomes `Southside Plumbing
   <southside-plumbing@send.makerbay.app>` with the owner's own address as
   Reply-To. One verified SES domain identity covers every tenant, so SPF and
   DKIM still pass and no tenant touches DNS.
2. **`replyTo` becomes REQUIRED when the audience is a customer.** A type
   error to omit it. That alone fixes issue 106 without needing inbound mail.
3. **Templates are hand-rolled in a new `packages/email`**, from a block model
   that renders HTML and text from the same source.
4. **Resend becomes the active provider now**; the SES appeal continues in
   parallel; **no automatic failover**.
5. **DMARC ramps to `p=reject`**, because the anti-phishing promise in the
   copy has no technical substance without it.
6. **Cognito templates get branded now**; `CustomEmailSender` later.

## 1. Template architecture

### Where it lives

```
packages/email/
  package.json          exports: "." and "./preview"
  src/
    blocks.ts           the document model, types only
    render.ts           renderEmail(doc) -> { subject, html, text }
    layout.ts           the base HTML shell and dark-mode CSS
    brand.ts            MakerBay identity vs tenant identity
    templates/*.ts      one per module
    render.test.ts
    __fixtures__/*.html golden files, committed
```

Templates live here rather than at each call site for the reason
`packages/core/src/color.ts` exists: nineteen copies of `json()` and three
disagreeing copies of `readableOn` are what the repo audit found. The module
keeps ownership of *what* it says by exporting a function returning a
document; the package owns *how it looks*.

### One layout, two identities

The layout does not branch on recipient class. It branches on **which brand it
was handed** - the pattern `modules/presence/api/src/render.ts` already uses,
taking `brandColor` as an argument rather than reaching for it.

```ts
export interface EmailBrand {
  name: string          // "Southside Plumbing" | "MakerBay"
  accent: string        // tenant brandColor, or #c2410c
  logoUrl?: string
  replyTo?: string
  footerNote: string    // "Sent by Southside Plumbing via MakerBay." | ""
}
```

### Getting the tenant's brand without cross-module reads

The four fields needed are scattered across four module-owned tables:
business name on `TenantRow`, brand colour on `AssistantConfigRow` overridden
by `PresenceConfigRow.accentColor`, logo from `PresenceConfigRow.photoKey`,
document prefix on `QuotesConfigRow`.

CLAUDE.md says data access goes through `packages/core` and is never
hand-rolled in module code, so the booking Lambda must not read the presence
table. **Denormalise a small `brand` blob onto `TenantRow`**, written by a
core helper the owning module calls when its own config is saved:

```ts
export async function putTenantBrand(tenantId: string, patch: Partial<TenantBrand>): Promise<void>
export async function getTenantBrand(tenantId: string): Promise<TenantBrand>
```

Presence calls it on config save; quotes calls it with `docPrefix`. One
`GetItem` we already make now returns everything an email needs. Staleness is
bounded to "until they next save", which is the right moment for a brand
change to propagate. Needs a one-off backfill script alongside
`seed-founder-grants.mjs`.

### The document model

The single most important decision: **the text part is not derived from the
HTML.** Both render from the same block list. That removes an
`html-to-text` dependency, guarantees the two never drift, and makes the
whole thing a pure function to assert on - the same shape as `renderPage`.

```ts
export type Block =
  | { t: 'para';   text: string }
  | { t: 'lede';   text: string }
  | { t: 'button'; label: string; href: string }
  | { t: 'link';   label: string; href: string }
  | { t: 'rows';   rows: Array<[label: string, value: string]> }
  | { t: 'total';  label: string; value: string }
  | { t: 'note';   text: string }
  | { t: 'code';   value: string }
  | { t: 'rule' }

export interface EmailDoc {
  brand: EmailBrand
  subject: string
  preheader: string
  heading: string
  blocks: Block[]
  unsubscribe?: { url: string; mailto: string }  // review asks + digest ONLY
}
```

Text rendering is about thirty lines: `para` wraps at 72 characters,
`button`/`link` become `${label}: ${href}`, `rows` become `  Label: value`.
That reproduces the style the current emails already have, so **the text part
is not a regression from today, it is today's email.**

`sendEmail` gains `html`, and when `html` is absent behaves exactly as now, so
migration is site by site with no big bang.

### Hand-rolled, not a library

Not on principle. On four facts about this repo:

1. **Two server-side HTML renderers already exist in exactly this shape.**
   `assistant/api/src/help.ts` (five themes, a `chrome()` shell taking props)
   and `presence/api/src/render.ts` (pure, documented as "no AWS, no clock, no
   I/O"). Both hand-roll `esc()`. Both are tested by string assertion. A third
   in the same idiom costs a reader here nothing.
2. **Bundle weight lands on eight mail-sending Lambdas** at 256MB. Pulling
   `react` + `react-dom` + `@react-email/components` into functions whose job
   is one DynamoDB write inflates cold start for no gain.
3. **The typecheck gap makes runtime templating riskier here.** CDK bundles
   with esbuild, which does not typecheck. A discriminated union is fully
   checked by `npm run typecheck`; a JSX tree compiled at runtime is not.
4. **The complexity is not there.** Twenty emails need nine block types and
   one layout, and `docs/design-guidelines.md` forbids the things that make
   email hard: "No shadows, no gradients. Depth comes from borders and
   background steps."

React Email's real gift is its preview server; section 6 replaces that in
about sixty lines with no dependency. It is MIT and works against SES, so this
is reversible if the template count triples.

## 2. HTML email reality

| Question | Answer |
|---|---|
| Tables or modern CSS | **Tables.** Classic Outlook Windows supports 59 of 307 tested features via the Word engine. No flex, no `border-radius`, `max-width` only on `<table>` |
| Inline styles | **Yes, for everything structural.** Gmail rendering a non-Google account has no `<style>` support at all, and caps `<style>` content, dropping the block and everything after it on overflow |
| `<style>` as well | Yes, additionally - media queries and dark mode cannot be inlined. Progressive enhancement, never load-bearing |
| Width | **600px fixed**, with an MSO ghost table |
| Web fonts | **No.** ~24% support, and a web font first in the stack makes classic Outlook drop the whole fallback chain to Times New Roman |
| Images | Always set HTML `width`/`height`. No SVG. **No base64.** Hosted PNG over HTTPS |
| Buttons | **Conditional-padding anchor, not VML.** Whole button clickable; VML has accessibility problems. Outlook renders square corners; accept that |
| CSS background images | **Never.** Gmail strips the entire `style` attribute or `<style>` block containing a `url()` with a valid image URL |

### Dark mode, and what it does to `readableOn`

Three behaviour classes, by share of opens: **Apple Mail (~64%) does not touch
your CSS.** Gmail web leaves the body alone; **Gmail iOS forces full
inversion**; Gmail Android inverts partially. **Outlook classic Windows
(~6.5%, skews B2B) forces full inversion** with no CSS targeting possible;
Outlook.com is partial and targetable via `[data-ogsc]`.

`packages/core/src/color.ts` picks ink or paper on a brand colour by measured
WCAG contrast. In email that guarantee splits:

- **Under full inversion the guarantee survives, the brand does not.** Both
  members of the pair are transformed by the same operator, so contrast is
  broadly preserved. What is destroyed is the hue: `#c2410c` inverts to a cold
  cyan. Nothing in CSS prevents this.
- **Under partial inversion the guarantee genuinely breaks.** Those clients
  transform background and text independently. `readableOn` computed a pair;
  the client keeps one half and rewrites the other. **This is the case to
  design against.**

Three consequences, all cheap:

1. **Never paint a large filled brand band.** Use the accent as a **4px top
   rule**, the **button fill**, and the **link colour**. A 4px rule inverting
   is damage nobody sees; a 200px header inverting looks broken. This is
   already house style: colour is reserved for meaning.
2. **Never let the brand colour carry meaning.** Already the rule.
3. **Add a dark-surface accent to `color.ts`.** The accent on a dark card
   fails contrast, and `tint()` is already in the file:

```ts
/** The accent, lightened only as far as it must be to read on a dark surface. */
export const accentOn = (accent: string, surface: string): string => {
  let c = accent
  for (let i = 0; i < 6 && contrastRatio(c, surface) < 4.5; i++) c = tint(accent, 0.15 * (i + 1))
  return c
}
```

Test it with the same hue table `color.test.ts` already uses.

**Avoid pure `#FFFFFF` and `#000000`** - Apple Mail inverts those exact values
even though it otherwise leaves your HTML alone. MakerBay is already safe:
`--bg` is `#faf9f7` and `--ink` is `#1c1917`. The design guidelines' "warm,
never pure grey" instruction happens to be the correct email instruction.

Declaring `color-scheme: only light` does **not** prevent forced inversion in
any client that matters. Declare `light dark` and design for it.

## 3. Provider: Resend now, SES appeal in parallel

| | SES | Resend |
|---|---|---|
| Can we send today? | **No.** Sandbox, verified recipients only. Suppression-management API calls are also disabled in the sandbox, so the admin console's suppression tool is **inert right now** | **Yes.** Production access from signup; domain verification in ~15 minutes |
| Approval risk | A prior request was **DENIED**. AWS publishes no denial taxonomy and no resubmission timeline | None |
| Price at <100/day | ~$0.30/month | Free tier is 3,000/mo but **capped at 100/day** - exactly our ceiling. Realistically **Pro at $20/month** |
| Tenant custom domains | **10,000 verified identities per region, free** | 10 domains on Pro, +100 for $20/mo |
| Data residency | Region of your choice | **All account data stored in the US**, regardless of sending region |
| Bounce webhooks | Config set event destinations. **We have configured none** | 20 event types, signed, retries, replay. Works out of the box |

**Migration cost is about two developer-days**, and only that small because
all twenty call sites already go through `sendEmail`. Split `notify.ts` into
`mail/ses.ts`, `mail/resend.ts` and an index picking on `EMAIL_PROVIDER`; put
the API key in Secrets Manager (**load the `aws-secrets-manager` skill first**
per CLAUDE.md, and use `{{resolve:secretsmanager:...}}`, never
`get-secret-value`); add a provider-agnostic shim for the suppression tooling
in `admin/src/pages/Email.tsx` and `admin-api/src/handler.ts`.

### Why not run both live with failover

The failure being insured against - provider outage - is rarer than the
failures it would create:

- An error *after* the provider accepted the message means retry sends the
  customer two invoices.
- Two providers means two suppression lists that never reconcile, so we would
  mail an address one of them suppressed. That is precisely the reputational
  harm suppression exists to prevent.
- Splitting under 100/day across two sending reputations warms neither.

**Both configured in DNS, one active via `EMAIL_PROVIDER`.** Cutover is an env
var and a deploy.

### Before replying to the SES case

Run this first:

```bash
aws sesv2 get-account --profile makerbay --region us-east-1 --query "Details.ReviewDetails"
```

If `Status` is **`FAILED`**, AWS never received the prior appeal and it can
simply be resubmitted. If **`DENIED`**, reply to case 178755823800807 with
`planning/ses-appeal.md`. That one command may save the whole exercise.

**The appeal still matters even if Resend carries product mail**, because
email OTP sign-in needs SES unless the spike in section 5 says otherwise.

### Revisit the provider choice when

Volume passes ~100k/month (SES is ~$10 against Resend's $90 tier), or tenant
custom sending domains ship, where SES's 10,000 free identities win decisively.

## 4. Deliverability

### What CDK already writes

`makerbay-stack.ts:206` does better than most: `ses.Identity.publicHostedZone`
writes the three Easy DKIM CNAMEs, and `mailFromDomain: 'mail.makerbay.app'`
writes the MAIL FROM MX and SPF.

| Record | Status |
|---|---|
| `mail.makerbay.app` MX and TXT, DKIM CNAMEs x3 | Already written by CDK |
| `makerbay.app` TXT apex SPF | **Add** - covers the `BehaviorOnMxFailure` fallback path |
| `_dmarc.makerbay.app` TXT | **Missing, add** |
| Resend DKIM + Return-Path on `send.makerbay.app` | **Add.** Coexists cleanly: different selectors, different Return-Path subdomain, and DMARC passes if *any* DKIM signature aligns |

Keep `BehaviorOnMxFailure` at the CDK default rather than `REJECT_MESSAGE`:
resilience is worth more here, because DKIM alignment carries DMARC on its own.

### DMARC ramp

```
Week 0    v=DMARC1; p=none; rua=mailto:<aggregator>; adkim=r; aspf=r; fo=1
Week 2-4  Read reports. Confirm every legitimate stream aligns.
Week 4    p=quarantine; pct=25 -> 50 -> 100
Week 8    p=reject; sp=reject
```

Keep `adkim=r` permanently - the Return-Path lives on a subdomain and strict
alignment buys nothing.

**The Cognito trap.** On `COGNITO_DEFAULT` today, Cognito sends from
`verificationemail.com`, so our DMARC policy does not apply. The moment issue
104 sets a custom `makerbay.app` FROM, that stream **must** DKIM-align or
`p=reject` silently kills every signup. **Test alignment before tightening
past `p=none`, and do not make both changes in the same week.**

### Mail on behalf of a tenant

**The rule: the From domain must be a domain we control and can authenticate.
The tenant's identity goes in the display name and the Reply-To.**

**Tier 1, the default, zero tenant setup:**

```
From:     "Southside Plumbing" <notify@makerbay.app>
Reply-To: "Southside Plumbing" <joe@southsideplumbing.com.au>
Footer:   Sent by Southside Plumbing via MakerBay.
```

The display name is what a phone shows, which is the entire brand
requirement. Shopify, Stripe, Calendly and Squarespace all do exactly this.
Sign with `d=makerbay.app` matching the From domain exactly, so Gmail does not
append its "via" annotation.

**Why not `From: joe@southsideplumbing.com.au`?** Because that is the spoof,
functionally and literally. Their domain almost certainly publishes SPF ending
`-all` without `amazonses.com`; we cannot produce a DKIM signature for a key
we do not hold; and if they publish DMARC at quarantine or reject the mail is
junked. We would also be teaching every recipient's filter that mail claiming
to be from that domain arrives unauthenticated from AWS, damaging **our
customer's** domain reputation.

**Two hardening steps Tier 1 requires, both currently absent:**

1. **`headerSafe()` next to `esc()` in core** - strip CR and LF, collapse
   whitespace, cap at 78, RFC 2047 encode non-ASCII. Issue 109.
2. **Validate the display name where tenants set it.** A business name is
   attacker-controlled text that will appear in strangers' inboxes on our
   authenticated domain. Reject names containing `@`, a URL, or a known-brand
   lookalike. Otherwise "PayPal Security" becomes a phishing sender with valid
   DKIM on makerbay.app, and we lose the domain.

**Tier 2, tenant's own domain: deferred, Genie tier.** Verify their domain as
an identity in our AWS account; they add three DKIM CNAMEs and a Return-Path
MX. Then `From:` is theirs and fully aligned. Model the UI on the existing
custom-domain flow. Not in v1.

### Gmail and Yahoo bulk rules

At under 100/day the **5,000/day bulk threshold does not bind**. But the
baseline requirements do at any volume: SPF or DKIM, TLS, valid forward and
reverse DNS, RFC 5322 formatting, **spam rate below 0.3%**.

**The trap: Google's bulk-sender status has no expiry.** Cross 5,000 on a
single day, across the whole primary domain, and you are permanently a bulk
sender. There is no safe moment to be caught unprepared, and it is the same
DNS work either way. **Implement the bulk set now.**

**One-click unsubscribe, a nuanced call.** RFC 8058 covers marketing and
subscribed messages, not transactional.

- **Never** on booking confirmations, quotes, invoices, reminders or
  cancellations. A customer must not be able to unsubscribe from their own
  invoice.
- **Do** add `List-Unsubscribe` and `List-Unsubscribe-Post` to the **review
  invitations** and the **daily digest**. A review ask is a promotional
  request to someone who never asked for it.

That split requires `Raw` MIME rather than `Simple`, which is why
`headerSafe()` is a prerequisite rather than a nicety.

## 5. Cognito, and email one-time-code sign-in

### What Cognito allows

| Mechanism | Brandable? | Works while SES is sandboxed? |
|---|---|---|
| **Static templates** (`userVerification` / `userInvitation`) | **Yes.** HTML, 20,000 chars body, 140 chars subject, must contain `{####}` | **Yes** - independent of the sending account |
| **`CustomMessage` trigger** | Only when `EmailSendingAccount` is `DEVELOPER`; otherwise returns HTTP 400 | **No** |
| **`CustomEmailSender` trigger** | **Fully.** Cognito stops sending and hands us the encrypted code | **Yes** - and it removes the 50/day cap |

**Now:** brand the static templates using `packages/email`, generated at synth
time by importing the renderer into the CDK app. It is a pure function with no
AWS dependency, exactly like `renderPage`, so the Cognito email and the
product emails come from one codebase and cannot drift.

**Later:** `CustomEmailSender`. It is the one change that simultaneously
unifies branding, removes the 50/day cap, and works while sandboxed. Cost: a
Lambda, a customer-managed KMS key, `@aws-crypto/client-node`, and CLI/CDK-only
configuration. Note `UpdateUserPool` is a full replace, so every other
parameter must be resent.

### Email OTP sign-in (issue 110)

**Native passwordless email OTP shipped 2024-11-22. Use it.** Do not build the
older `CUSTOM_AUTH` trigger trio - AWS themselves now direct people away from
it.

**The installed CDK already supports it.** `aws-cdk-lib` resolves to 2.266.0
and `aws-cognito/lib/user-pool.d.ts` carries both `allowedFirstAuthFactors`
and `emailOtp`.

```ts
const userPool = new cognito.UserPool(this, 'UserPool', {
  featurePlan: cognito.FeaturePlan.ESSENTIALS,
  signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true } },
})
const userPoolClient = userPool.addClient('Dashboard', {
  authFlows: { user: true, userSrp: true, userPassword: true },
})
```

Flow is `InitiateAuth` with `AuthFlow: 'USER_AUTH'` and `PREFERRED_CHALLENGE:
'EMAIL_OTP'`, then `RespondToAuthChallenge`. Fully SDK-drivable, so the
existing React login stays.

| Constraint | Detail |
|---|---|
| Feature plan | Essentials or higher. 10,000 MAU free, so **$0 at our scale** |
| **SES required** | Documented as requiring SES email configuration. **This is the blocker** |
| MFA cannot be required | Fine for the customer pool. **Never enable it on `staffPool`**, which is deliberately `mfa: REQUIRED` |
| Code validity | `AuthSessionValidity` 3-15 minutes, default 3. **Set 10** - a tradesperson switches to their phone |
| Lockout | Exponential timeout after 5 failed attempts |
| Code length | **Undocumented.** Accept **6-8 digits**; do not hardcode a six-box mask |
| Resend | **No documented resend path** for an in-flight challenge. Restart with `InitiateAuth` and debounce client-side |

### The spike worth running first, one day

The docs say email OTP requires SES configuration. They also say
`CustomEmailSender` means Cognito invokes a Lambda **instead of** its default
behaviour, and explicitly list a `CustomEmailSender_Authentication` source for
sign-in OTPs.

Those two statements suggest, but nowhere state, that `CustomEmailSender`
satisfies the requirement without SES production access. **Stand up a
throwaway pool with Essentials + `EMAIL_OTP` + `CustomEmailSender` +
`COGNITO_DEFAULT` and call `InitiateAuth`.** If it works, passwordless login
stops being blocked by the SES appeal entirely. This is the highest-leverage
unknown in the document.

### What the OTP email must contain

- Code **in the subject line**, so it is readable off a lock screen without
  opening anything.
- **No link at all.** A code email containing a button trains the exact click
  a spoofed copy needs. Non-negotiable.
- The workspace name - a bulk phisher does not know it.
- Requesting context: browser, platform, approximate location.
- The standing line: *"Nobody from MakerBay will ever phone, text or email you
  asking for it."* The realistic attack on a sole trader is not a spoofed
  email, it is a phone call while they are under a sink.

Three design rules go with the copy, because copy alone does not make OTC safe:
**ten-minute expiry, single use, five attempts then the code dies**; show the
requesting context; and **bind the code to the session that asked for it**, so
a code read aloud cannot be used by the caller from their own browser. That
last one is the control that actually defeats the phone-call attack.

## 6. Bounces, complaints and suppression

### The design

**One internal event shape, two provider adapters.** Add message tags at send
time so every event traces back to the row that caused it:

```ts
export interface EmailInput {
  to: string; subject: string; text: string; html?: string
  replyTo?: string
  audience: 'owner' | 'customer' | 'staff'
  ref?: { tenantId: string; moduleId: string
          refType: 'booking'|'quote'|'invoice'|'request'|'review'|'auth'
          refId: string }
}
```

SES `EmailTags` allow alphanumerics, hyphens and underscores, and ULIDs are
Crockford base32 uppercase, so they pass unmodified.

- **SES:** an EventBridge event destination on the config set for `BOUNCE,
  COMPLAINT, DELIVERY, REJECT, RENDERING_FAILURE, DELIVERY_DELAY`. EventBridge
  rather than SNS, because the `makerbay` bus already exists and CLAUDE.md
  treats it as a stable contract.
- **Resend:** a webhook route verifying the Svix signature over the **raw
  body**, normalising into the same shape.

**Where the result lands.** Not in module tables written by a shared Lambda -
that violates the ownership boundary. A core-owned table:

```
MailLog   pk: tenantId   sk: messageId
          GSI1: tenantId + "refType#refId"
          { state, bounceType, bounceSubType, diagnostic, at, to, audience }
```

Modules read it through a core helper, so `emailFailedChip` starts telling the
truth. It also gives the tradesperson a per-tenant mail history, which is what
they actually want when they ask "did she get it?".

### Who is told what

| Event | Who | How |
|---|---|---|
| **Hard bounce, customer address** | The tradesperson, promptly | Row shows "Didn't arrive - the address looks wrong", with the address so they can spot the typo. One owner email, rate-limited to one per contact per day. Mark the Contact `emailStatus: 'bounced'` |
| Soft bounce / delay | Nobody until it persists past 24h | Row shows "still trying" |
| **Complaint** | **Not the tradesperson, in those words** | Suppress; set `emailStatus: 'complained'`; permanently stop review asks and digests to that contact; log for staff. Surface only as "This customer has asked not to receive email." Telling a plumber their customer reported them as spam, over what is usually a misclick, is a support ticket we generated for ourselves |
| **Bounce on the owner's `notifyEmail`** | **Loudly** | A dead notification address is a silent product failure - the tradie thinks they have no work. Dashboard banner, plus SMS if a number is on file |
| Any complaint; 3+ bounces in an hour | Staff | Reuse the `makerbay-abuse-alerts` SNS topic |

**On alarm thresholds, and this matters more than it looks.** SES reviews at
5% bounce and **0.1% complaint**. At 100 sends a day **a single complaint is
1%, ten times the review threshold.** Rate-based alarms are meaningless at
this volume and will page constantly. **Alarm on absolute counts** until we
are past a few thousand a day.

### Tenant-scoped suppression over a global list

Provider suppression is account-wide, so one tenant's bounce suppresses that
address for **every** tenant. Two plumbers sharing a customer is not
hypothetical. Add a **pre-send check inside `sendEmail`**:

```ts
if (input.ref && await contactEmailBlocked(input.ref.tenantId, to)) {
  return { sent: false, error: 'address_bounced' }
}
```

with matching copy in `explainEmailError`. This gives per-tenant semantics
over a global list, stops us paying to send to known-dead addresses, and lets
the tradesperson clear the flag themselves by correcting the address instead
of opening a support ticket for a staff-only console.

Keep the staff suppression viewer as the account-level escape hatch, with two
copy changes: say plainly that removal is **global across all workspaces**,
and note it is inert while sandboxed so nobody debugs a working tool.

## 7. Testing and preview

Five layers, four free, two working today under the sandbox.

1. **Unit tests** in the existing `npm test`. Model on `render.test.ts`.
   Assert: every template produces a non-empty text part and **every `href` in
   the HTML also appears in the text part**; `esc()` survives a `<script>` in
   the business name; **`headerSafe()` survives `\r\nBcc: attacker@evil.com`**;
   the shell is 600px and the button 44px; `readableOn(brand)` appears paired
   with `brand` for the awkward hues `#eab308`, `#1a73e8`, `#c2410c`.
2. **Golden files**, committed, regenerated by `npm run email:snap`. The
   founder reviews template changes as a diff.
3. **Preview harness**, `scripts/email-preview.mjs`, about sixty lines, no
   dependencies. Renders all templates against two fixture tenants - a warm
   `#c2410c` and the nasty mid-yellow `#eab308` - into 600px and 375px
   iframes.
4. **Mailpit in CI.** Actively maintained, and the right tool for three
   reasons: an HTML check scoring client compatibility from caniemail data, a
   link and linked-image checker, and SpamAssassin scoring, all over a REST
   API. CI can fail the build when the compatibility score regresses. Do
   **not** use MailHog - last commit 2022.
5. **Provider simulators.** **The SES mailbox simulator works in the
   sandbox** - `bounce@`, `complaint@`, `ooto@simulator.amazonses.com`, with
   `+label` support. They do not count against quota or affect reputation.
   **This is the most useful fact in the plan: the entire bounce pipeline can
   be built and end-to-end tested today.**

**Real-client screenshots: do not buy any yet.** Instead a free manual matrix
**once per change to the base layout**, not per template: Gmail web, Gmail iOS
(forced dark), Outlook.com, Apple Mail. That covers ~95% of opens and both
clients that force inversion.

**One trick to use immediately:** verify three or four of our own addresses
across Gmail, Outlook.com and Yahoo as SES identities. The sandbox permits
sending to verified addresses, so genuine cross-provider and dark-mode testing
is available **today**.

## 8. Build plan

| Phase | Work | Days | Blocked? |
|---|---|---|---|
| **0. Unblock** | Run `get-account`, read `ReviewDetails.Status`, resubmit or reply to the case. In parallel: Resend account, verify domain, DNS | **0.5** | No |
| **1. `packages/email`** | Block model, `renderEmail`, layout, text renderer, `accentOn`, `getTenantBrand` + backfill, unit tests, preview harness | **3** | No |
| **2. Migrate 20 call sites** | Extend `sendEmail` with `html`, `ref`, `audience`, required `replyTo` for customer mail. **`headerSafe` and the eight missing Reply-To first, as P0.** Then quotes, booking, requests, reviews, voice, support | **2.5** | No |
| **3. Provider switch** | `mail/ses.ts`, `mail/resend.ts`, `EMAIL_PROVIDER`, key via Secrets Manager, suppression shim | **1.5** | No |
| **4. Deliverability** | Apex SPF, `_dmarc` at `p=none` with monitoring, confirm both providers coexist, validate | **1.5** | No |
| **5. Bounce pipeline** | Event destination, `MailLog`, Resend webhook, Contact `emailStatus`, pre-send check, owner notices, absolute-count alarms | **3** | **No** - simulator works sandboxed |
| **6. Cognito parity** | Static templates rendered by `packages/email` at synth time, both pools | **1.5** | No |
| **7a. OTP spike** | Does `EMAIL_OTP` work with `CustomEmailSender` and no SES production access? | **1** | No |
| **7b. Email OTP sign-in** | Feature plan, sign-in policy, client auth flows, React login flow, 6-8 digit input, debounced resend | **3** | Depends on 7a |
| **8. DMARC ramp** | none -> quarantine -> reject. **Verify Cognito aligns before quarantine** | **0.5** over 8 weeks | No |
| **9. Tenant sending domains** | *Deferred.* SES CNAME delegation, Genie tier | **4** | Yes |

**Core path, phases 0-6: about 13.5 developer-days, none of it blocked.**

### Do first, this week

Phase 0 (half a day, unblocks everything), then the two P0 correctness fixes
inside phase 2: **`headerSafe` on the tenant name, and `Reply-To` on the eight
customer emails that lack it.** Those are a few hours and they stop replies
from paying customers being thrown away, which is happening right now.

## Open questions

- Whether `CustomEmailSender` satisfies Cognito's SES requirement for
  `EMAIL_OTP`. **The key unknown; phase 7a settles it.**
- Whether Cognito on `COGNITO_DEFAULT` with a custom `makerbay.app` FROM
  produces a DKIM signature that aligns for DMARC. **Test before `p=none`
  becomes anything stricter.**
- Cognito OTP code length, and any resend path for an in-flight challenge.
- Whether the SES 3,000-message free tier still applies; the pricing page now
  advertises only credits.
- SES's granted quota on approval - AWS publishes no default.
