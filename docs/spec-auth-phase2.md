# Spec: sign-in phase 2 - people in a workspace, and passkeys (issue 158)

Status: **v2 APPROVED 2026-09-09 on the defaults; Part A LIVE 2026-09-09; Part B0 (auth on the dashboard's origin) LIVE 2026-09-09; Part B1 (passkeys) LIVE 2026-09-09; founder confirmed passkey sign-in on a phone and the upstream password sign-in ("Sign in with it") through the app. callback on 2026-09-10; the old api. Cognito callback is removed, so one callback is registered. The Cognito page itself moved to managed login with a MakerBay branding style (infra/branding/upstream-login.json) the same day, after the founder saw the unbranded classic page.**
Proven end to end against the deployed API with two test addresses: invite
(email delivered, no link), seat wall on the third person, invitee sees the
invitation at sign-in, joins as member, is refused every owner route, leaves
and is signed out everywhere; privacy pass removed the test workspace's
identity rows; the canary asks the live front door for a code hourly and
sends a tagged probe through the same mail pipeline, passing only when the
provider's delivery event reaches our mail log (Resend's list API needs a
full-access key, which the secret deliberately is not). B0 proven live:
`/auth/*` answers on app.makerbay.app with caching disabled, the CSRF
rejection arrives as a JSON 403 rather than a rewritten 200, a code
sign-in through the dashboard origin sets an HttpOnly `__Secure-`
session cookie, `/auth/token` from the cookie alone mints a JWT whose
issuer is api.makerbay.app and the API accepts it, sign-out kills the
cookie, and the anonymous dashboard load probes the session once and
shows the sign-in page. B1 proven live with a software authenticator
(`scripts/passkey-smoke.mjs`, a P-256 key playing the phone): a
registration without user verification is refused with
`USER_VERIFICATION_REQUIRED`, one with it is stored under the given name,
an anonymous browser signs in with the credential and mints a token the
API accepts, an assertion without user verification is refused and sets
no session, rename and remove work, and a removed credential can no
longer sign in. Add and remove each emailed the account. Two deviations
from the table below: `session.freshAge` is 1 hour as specified, but
the plugin only verifies with `requireUserVerification: false`, so the
"required" is enforced in the two `afterVerification` callbacks; and
the Account page shows created dates only, because the plugin's row has
no last-used field and adding one outside its schema is not safe with
the adapter factory. Builds on
docs/spec-auth.md (live). v1 proposed Better Auth's organization plugin
mirrored into the Users table; a product review and a security review of
that draft, run independently, both rejected it - the product review as
machinery for "invite one email", the security review because every
hook-mirroring half-failure produced a wrong authorizer answer. v2 keeps
membership in core, where the authorizer already reads it. The reviews'
other findings are folded in and marked where they changed a decision.

## Purpose

Two things, neither a fix:

1. **A workspace can have more than one person.** Today a workspace has
   exactly one user, its owner. The Users table has a `member` role nothing
   has ever written, there is no invitation flow, and the day a plumber's
   partner wants to answer enquiries from the kitchen table, the product has
   no answer. It is also the one item on the sign-in roadmap that can be a
   reason to pay, and the one most likely to produce the first testimonial:
   "my wife runs the enquiries now" beats "I sign in with my thumb".
2. **One-tap sign-in.** A returning user types their email, waits for a
   code, types the code. Fine once a week; not fine with wet hands between
   jobs. A passkey is the fingerprint or face the phone already uses, no
   email round trip, and there is no code to read out to a caller.

## Non-goals

- A person in more than one workspace. The Users table is keyed by user
  with one `tenantId`; the authorizer resolves through it; nobody has
  asked. The design below leaves the door open (see "Later").
- Teams, custom roles, an admin role, ownership-transfer UI, per-seat
  pricing (the market research names it as the complaint to avoid).
- A second factor for customers. Passkeys are a first factor; the code is
  the fallback.

## Part A - people in a workspace

### Design: membership lives in core

Membership is a Users row. It already is: `UserRow { userId, email,
tenantId, role, createdAt }`, read by the authorizer on every request and
by `requireOwner` on every owner-only route. Phase 2 adds what is missing
around it and nothing underneath it:

- **Users table** gains a GSI `byTenant` (tenantId → rows), replacing the
  full-table Scan in `listTenantUsers`, and two fields: `notify: boolean`
  (does this person get the owner-style notifications) and `invitedBy`.
- **Invitations** are rows in a new core table `Invitations`
  (`tenantId`, `invitationId`; GSI `byEmail`), with `email`, `role`,
  `inviterId`, `status`, `expiresAt` (TTL), `createdAt`. Seven-day expiry.
- **Four core routes**, all under `/v1/core/people`, owner-only except
  the two an invitee uses:
  - `GET /v1/core/people` - members with role, notify flag, last sign-in
    (from the auth table's session rows by user), and pending invitations.
  - `POST /v1/core/people/invitations` - invite `{ email, role }`.
  - `POST /v1/core/people/invitations/{id}/resend|cancel`.
  - `PATCH /v1/core/people/{userId}` - role or notify; `DELETE` - remove.
  - `GET /v1/core/me/invitations` and `POST /v1/core/me/invitations/{id}/accept|decline` - the invitee's side, matched on the session email.
- **Sessions** for a removed person are revoked by deleting their rows in
  the auth table by user (a small helper in `packages/auth` that knows the
  key layout and nothing else; core-api already has the table name).

Why this and not Better Auth's organization plugin: the plugin is the
right tool the day a person belongs to two workspaces, because then the
active organisation has to travel in the token. Today it would mean two
sources of truth about membership and a hook per transition to keep them
aligned, and the security review found that each hook's failure mode -
member row without a Users row, or the reverse - is a wrong authorizer
answer that persists. Core-owned membership has one write per transition,
each conditional, and the authorizer does not change at all. Better Auth
still owns identity: who the person is, how they sign in, their sessions
and passkeys.

**Later:** when multi-workspace is wanted, the Users row becomes one
membership row among several, the active workspace moves into the JWT
via `definePayload`, and the authorizer reads the claim. Nothing built
here is in the way of that; the Invitations table and routes survive.

### Workspace creation

Unchanged: `POST /v1/core/tenants` refuses when the caller already has a
Users row (it does today, `tenant_already_exists`), so a member cannot
create a second workspace and an owner cannot create two. This is the
invariant the plugin design could not hold without extra guards.

### Roles

Two, deliberately: **owner** and **member**. Everything a member cannot do
is already an owner-only route that already checks `requireOwner`:
billing, API keys, module on/off, workspace name and address, aliases,
Genie write confirmations. Phase 2 adds only the People routes to that
list, and populates `role` on `/v1/core/me` so the dashboard can hide
what a member cannot do rather than let them find out by clicking. Any
other role value is rejected at the routes.

The owner role is not offered in the invite form (product review: nobody
needs a second owner yet, and a warning is read by exactly the person who
should not click). The API accepts it, so ownership transfer is possible
by hand when a customer needs it.

### Seats

| Plan | People | Reasoning |
|---|---|---|
| Free | **2** | A sole trader and their partner is a household, not a firm. The product review was right that "you cannot add your wife" is the wrong first paywall for a tier that must not feel paywalled on basics. |
| Trade | 3 | Owner, partner, one more. |
| Genie | 10 | A small firm. |

Enforced in the invite route: members plus pending invitations must be
below the plan's limit, read through the existing entitlement helpers.
Pending invitations count so a free workspace cannot queue invitations
and accept them after upgrading. At most 10 pending per workspace. The
wall says, in the owner's words: "Free includes two people. Trade lets
you add up to three, from $29 a month." Never "seat". The same sentence
appears on the pricing page and the Billing page, so the first upgrade is
not a surprise.

### Inviting someone

1. Owner, Workspace page, "People" card: email, Invite. (Role is member.)
2. The route creates the invitation and sends the email through
   `sendEmail`, owner-audience, from `hello@makerbay.app`, display name
   the business, Reply-To the owner.
3. **The email carries no link.** v1 had a button to `/invite/<id>`; the
   security review showed that reinstates exactly the pattern phase 1
   removed: a page reached from an email that immediately asks for a code
   is the code-relay phishing pretext, now MakerBay-shaped. So the email
   says: *"Mark from Southside Plumbing has added you to MakerBay. Sign in
   at app.makerbay.app with this email address and the invitation will be
   waiting. It works for a week."* Subject: *"Mark from Southside Plumbing
   has added you to MakerBay"*. Typing the address is the same habit the
   code emails teach.
4. The invitee signs in with a code as anyone does. `me` returns their
   pending invitations (matched on the session email, lowercased), and the
   dashboard shows *"Join Southside Plumbing?"* with **Yes, join** and
   **No thanks** before anything else - before Onboarding, if they have no
   workspace.
5. Accept writes the Users row conditionally on `attribute_not_exists`,
   marks the invitation accepted, records an audit entry on the workspace,
   and the dashboard loads it.
6. **An invitee who already has a workspace** is not refused at invite
   time (the security review: that refusal is an oracle for which emails
   have accounts; the product review: the partner who tried MakerBay in
   March and left an empty workspace is the likely case). The invitation
   is created and sent as normal. At accept, if their existing workspace
   has no activity beyond creation, Accept offers *"You have an empty
   workspace of your own. Close it and join Southside Plumbing?"* and does
   both. If it has activity, the page says *"This email already runs its
   own MakerBay workspace. To join Southside Plumbing instead, close that
   workspace under Settings first, or ask Mark to invite a different
   address."* Closing a workspace is a new owner-only action
   (`DELETE /v1/core/tenants/{id}` with a typed confirmation) that
   suspends the tenant and drops the Users row; full erasure stays the
   privacy script's job.
7. Owner-side copy never says "refused": *"Invitation sent. If that
   address already has its own workspace they will be asked to close it
   before joining."*

Pending invitations are listed on the People card with Resend and Cancel.

### Removing someone, changing a role

- Remove: a visible **Remove** on the People card with the consequence
  spelled out: *"Sam will lose access within a few minutes. Their quotes
  and notes stay with the business."* The route deletes the Users row and
  revokes every session of that user. Residual access is bounded by the
  authorizer cache (5 minutes) plus the life of an access token
  (15 minutes): up to 20 minutes, the same residual the kill switch has,
  and documented in the runbook. A shorter window means a shorter
  authorizer cache, a separate decision.
- **Leave workspace** on the member's own Account page, same mechanics,
  so an ex-apprentice does not have to ask the boss.
- The last owner cannot leave or be removed. Ownership transfer is
  API-only for now.
- A removed person sees Onboarding next time, as if new.
- API keys keep a `createdBy`; a key made by a since-removed person keeps
  working until the owner revokes it, which the keys page now shows.

### What members see and get

- **Notifications.** The product review's sharpest point: a partner who
  can answer enquiries but is never told one arrived is a seat that does
  nothing. Every owner-bound notification (new booking, new enquiry, quote
  accepted, deposit paid, missed call) goes to every person on the
  workspace with `notify` on, which is the default on invite and can be
  turned off per person by an owner on the People card or by the person
  themselves. This is the one place where "no per-user data" ends; one
  boolean, on the row that already exists.
- Missed-call texts come from the business number, not a person; the voice
  module must not assume owner = the person on the phone.
- Shell: Billing, Usage and Workspace settings are hidden for members;
  the Home checklist and the setup screens are hidden too (the product
  review caught that Onboarding-style steps shown to the partner would
  confuse). The role is not printed under the email; it appears only at
  a wall: *"Ask Mark, the owner, to change this."*
- **Activity page** shows the actor's email (already recorded as the audit
  label) and falls back to "a team member"; today it prints "· you" for
  any user actor, which becomes a trust bug the moment two people act.
  Ships with the People card, not after it.

### Send caps, abuse

Nothing changes. Caps, suppression and the complaint brake are per tenant.
Invitation volume is bounded by the seat limit, the 10-pending cap and the
per-route rate limit.

### Staff console, privacy, canary

- Tenant detail shows role, notify flag, pending invitations, and who
  invited whom and when. "Send password reset" appears only for users with
  a Cognito account row; a code user has no password.
- **Privacy pass over the auth table** ships in this phase regardless: the
  delete script cannot see `makerbay-auth` today because its rows carry no
  tenantId. For each Users row of the tenant it removes that person's user,
  accounts, sessions, passkeys, verification and rate-limit rows, and the
  email uniqueness marker **in the same transaction as the user row** - an
  orphaned marker blocks that address from ever signing up again.
- **Canary.** The current one signs up against Cognito, a path no new
  customer uses. It becomes: request a code for `delivered@resend.dev`
  through the live front door, then confirm through Resend's API that a
  message to that address was created after the request and reached
  `delivered`, and publish the metric only then. The security review is
  right that asserting on the API's `success` alone would be green during
  exactly the outage it exists to catch. Hourly. About 720 Resend messages
  a month; fine on the paid tier, a quarter of the free tier's daily cap,
  so the tier is confirmed before this ships.

## Part B - passkeys

### One prerequisite: auth on the dashboard's own origin

The passkey plugin binds each ceremony to a signed challenge cookie.
Cookies do not cross from `api.` to `app.`, and the API's CORS allows every
origin, which browsers refuse to pair with credentials. So the auth
endpoints must be reachable on the dashboard's origin before passkeys can
work at all.

The dashboard's CloudFront distribution already proxies other paths to
`api.makerbay.app`. It gains one behaviour, `/auth/*` → `api.makerbay.app`,
with the managed caching-disabled policy, the all-viewer-except-host
origin request policy, and all methods allowed. Better Auth's `baseURL`
becomes `https://app.makerbay.app`; its cookies become first-party; the
Cognito callback becomes `https://app.makerbay.app/auth/callback/cognito`
and the old `api.` callback is removed from the client once the new one
works, so there is one.

**Two things the security review caught in this move:**

- The distribution rewrites every 403 and 404 into `200 index.html` for
  SPA routing. Under `/auth/*` that would turn Better Auth's CSRF rejection
  and every permission error into a 200 with an HTML body, which the
  client reads as success. Those error rewrites are replaced by a CloudFront
  Function on the default behaviour that maps extension-less paths to
  `/index.html` (the pattern the marketing site already uses), so API
  errors pass through untouched. The deploy check posts a state-changing
  auth call with a wrong Origin and asserts a 403 JSON body.
- The JWT issuer must not move with `baseURL`. Today issuer and audience
  are set from `baseURL`; moving it would mint tokens the authorizer
  rejects. Issuer and audience become an explicit `AUTH_ISSUER`
  (`https://api.makerbay.app`, an opaque identifier), the JWKS stays at
  `api.makerbay.app/auth/jwks`, and the deploy check decodes a fresh token
  and asserts the issuer.

With cookies first-party, the `/auth-bridge` one-time-token dance after a
Cognito sign-in is retired, and the dashboard stops keeping a session
token in localStorage: the cookie carries the session, and the 15-minute
access token lives in memory only. CSRF is covered twice: Better Auth
checks Origin against `baseURL` on any request carrying a cookie, and the
session cookie is `SameSite=Lax` (Strict would break landing from the
Cognito redirect). Conditions written down so nobody undoes them:
`AUTH_EXTRA_ORIGINS` stays empty in production; the API's CORS never gains
allow-credentials; the streaming chat URL stays bearer. The deploy check
also confirms Better Auth's rate limiter keys on the viewer address, not
the CloudFront hop, by sending six code requests and expecting a 429.

### Configuration

| Setting | Value | Why |
|---|---|---|
| `rpID` | `makerbay.app` in production, from env | Credentials bind to it for life; the apex covers `app.` and any future host. |
| `origin` | exactly `['https://app.makerbay.app']` in production; localhost only in a dev build | WebAuthn refuses an rpID that does not suffix the origin, so localhost cannot share the production rpID anyway, and a localhost entry in production would be a needless weakening. |
| `userVerification` | **required** | As a passwordless first factor, "preferred" would accept a PIN-less key, which is possession-only and weaker than the inbox-protected code. |
| `residentKey` | preferred | Lets the browser offer the passkey before an email is typed. |
| `session.freshAge` | 1 hour (from 24) | Adding or removing a passkey needs a session younger than this. |

### Flows, in the customer's words

Nobody in this audience knows the word "passkey"; it appears only as a
subheading on the Account page after a plain sentence.

- **Offer, after a code sign-in** on a device that reports a platform
  authenticator. Card: *"Sign in with your fingerprint next time. No code
  to wait for, on this phone only."* Buttons: **Use fingerprint** /
  **Not now**. Not now is remembered per browser; the offer returns after
  the third code sign-in on that browser, not after a calendar interval
  (the product review: "you keep doing the slow thing" is the right
  trigger, not a monthly nag).
- **Sign in.** The email field carries `autocomplete="username webauthn"`
  so a browser with a saved passkey offers it before anything is typed;
  a button *"Sign in with fingerprint or face"* does the same explicitly.
  Success creates the session exactly as a code does. The code remains one
  click away and is the recovery path.
- **Account page** (new; the account menu has no page today): passkeys by
  name, created and last-used dates, Rename, Remove, Add another device;
  Leave workspace for members. Adding or removing requires a session under
  an hour old, and **every add or remove emails the account** (a stolen
  session registering a passkey that outlives sign-out-everywhere is the
  attack; the email is the tripwire, and the list is where it is undone).
  A code re-check before add or remove is the stronger control; it is
  noted as the next step, not built here.

### Data

The `passkey` model is already in the adapter's index map. The package
`@better-auth/passkey` is not yet installed; it is installed at the same
pinned version as `better-auth`. Rows are removed with the user by the
privacy pass.

## What this phase does not touch

The authorizer, the module Lambdas, the MCP endpoint, the API-key model,
billing, and the mail pipeline.

## Build plan

| Order | Work | Days |
|---|---|---|
| A0 | Users GSI and fields, Invitations table, the People routes, seat limits, session revocation helper, `me.role` and `me.invitations`, activity attribution | 2 |
| A1 | Invitation email, People card (invite, resend, cancel, remove, notify, last sign-in), join prompt, close-workspace action, shell by role, Account page with Leave | 2 |
| A2 | Notifications to every `notify` person, staff console, privacy pass, canary on the new front door | 1 |
| B0 | CloudFront `/auth/*` behaviour and SPA function, baseURL move, explicit issuer, Cognito callback, cookie sessions, retire the bridge, deploy checks | 1 |
| B1 | Passkey plugin, offer card, sign-in autofill and button, Account page list, add/remove emails | 2 |

Eight days. **People first** (product review): it creates a reason to pay
and a second pair of hands on the product; passkeys make returning users
happier, which matters after there are returning users. B0 is a day and
removes real complexity, so it follows A directly.

Stack cost: Invitations table and its GSI, one Users GSI (about 3
resources in the parent, at 421), a CloudFront behaviour and function
(part of the distribution plus 1), an app-client callback change. Nothing
in the auth stack.

## Risks

- **Removal is not instant.** Up to 20 minutes; documented; same as
  suspension.
- **CloudFront in front of auth.** A behaviour that cached
  `/auth/get-session` would serve one person's session to another. Managed
  caching-disabled policy, and the deploy check hits it twice with
  different sessions and asserts different bodies before the dashboard
  build is published.
- **Passkey on a shared device.** The card says "on this phone only"; the
  Account page lists every passkey by name and date; every add and remove
  is emailed.
- **Advisory cadence.** The passkey package is one more surface. Same rule
  as phase 1: pin, monthly advisory check, minimal plugin list.

## Founder decisions (defaults in bold)

1. Roles: **owner and member only**.
2. Seats: **Free 2, Trade 3, Genie 10**, bundled.
3. Invitation email: **no link; "sign in at app.makerbay.app and it will
   be waiting"**. The alternative, a link to the ordinary sign-in page,
   reintroduces the phishing pretext phase 1 removed.
4. Invitee who already has a workspace: **invite anyway; at accept, offer
   to close an empty workspace, otherwise explain**.
5. Member notifications: **on by default for every person, per-person
   switch**.
6. Passkey offer: **after a code sign-in; if declined, again after the
   third code sign-in on that browser**.
7. Passkey user verification: **required** (fingerprint, face or PIN every
   time).
8. Canary: **hourly, asserting on Resend delivery, not on the API**; Resend
   tier confirmed first.
9. Order: **people (A) first, then B0, then passkeys (B1)**.
