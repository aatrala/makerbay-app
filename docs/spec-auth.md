# Spec: customer authentication on Better Auth (issue 157)

Status: **PHASES 0 AND 1 SHIPPED DARK 2026-09-09.** The adapter passed Better
Auth's conformance suites (114 of 116; the two misses are the harness's
30-second timeout over the WAN, not failures). The AuthStack is deployed,
JWKS is live at `https://api.makerbay.app/auth/jwks`, the six existing
users are migrated, and the dashboard build carries both sign-ins. Test
the dark path at `https://app.makerbay.app/?auth=better-auth`. Production
still signs in on Cognito until `AUTH_PROVIDER` and
`DEFAULT_AUTH_PROVIDER` flip (phase 1b). Founder decisions listed at the
end; defaults apply until changed.

**Still to prove before the flip:** a full emailed-code sign-in on the live
dashboard. With SES as the active mail provider that needs a verified
address; with Resend it works for anyone, and the code can be read back
through Resend's sent-mail log. Everything up to the code check is proven
live (the send lands, a wrong code is refused, the JWT verifies).

## Why

Cognito's built-in mailer is capped at 50 messages a day and unbranded, the
SES account is sandboxed with production access denied twice (issue 76), and
sign-up broke silently for three days when the email path failed. Email
one-time-code sign-in (issue 110) is documented as needing SES. Every hosted
alternative was evaluated (WorkOS, Clerk, Kinde, Stytch, Auth0, Descope,
Hexclave, Ory, Zitadel, Logto, SuperTokens, Hanko, FusionAuth, Firebase,
Supabase) and every self-hosted one. Better Auth is the only option that
keeps auth inside the CDK stack with no server, no Postgres and no vendor in
the request path, sends its email through the Resend pipeline built in issue
156, and exposes a JWKS the existing authorizer can verify.

## What "swappable" means

Better Auth is NOT an adapter over other identity providers. It is the
identity provider, with two pluggable seams:

1. **Below:** the database adapter. Ours is DynamoDB (`packages/auth`).
2. **Above:** upstream sign-in providers via the generic OAuth plugin. The
   existing Cognito user pool is wired here as an OIDC provider, so today's
   users keep their passwords and "sign in with your MakerBay password" works
   with no password export. WorkOS, Google or any OIDC provider is a config
   addition in the same list.

So "keep Cognito" holds: Cognito remains the credential store for password
sign-in, indefinitely. What cannot hold is Cognito as the system of record
with Better Auth as a shim - Better Auth owns users and sessions.

The staff console stays on Cognito, untouched: MFA is enforced, staff are
created out of band, and it has no email problem.

## Architecture

- `AuthFn` (new, `packages/auth`) mounts `betterAuth()` at
  `https://api.makerbay.app/auth/*`. API Gateway v2 events are converted to a
  Web `Request` for `auth.handler()`; the `Response` maps back.
- Storage: one table `makerbay-auth`, single-table, three GSIs, TTL.
- Plugins: `emailOTP` (codes via `sendEmail` + `authEmail('signin')`),
  `bearer` (the SPA keeps `Authorization: Bearer`; cookies cannot cross
  app./api. origins with `allowOrigins: ['*']`), `jwt` (JWKS at
  `/auth/jwks`, EdDSA, 15-minute tokens), `genericOAuth` (Cognito upstream),
  `oneTimeToken` (cookie-to-bearer handoff after the OAuth redirect).
  Phase 2: `passkey`, `organization`.
- `authorizer.ts` becomes dual-issuer: Cognito `iss` → `aws-jwt-verify` as
  today; `https://api.makerbay.app` `iss` → `jose` remote JWKS. Context
  `{ userId, email, tenantId, scopes, entitlements }` is unchanged, so module
  Lambdas, the MCP endpoint and workspace creation do not change.
  `chat-stream.ts` gets the same dual verifier through a shared helper.
- Users table stays keyed by `userId`. Existing users migrate with
  `id = Cognito sub` plus an `account { providerId: 'cognito', accountId: sub }`
  row, so nothing is re-keyed.

### Flows

- **Sign-up / sign-in with a code:** SPA asks for a code → AuthFn stores the
  hashed OTP and sends the branded email through Resend → SPA submits the
  code → user created on first use, session token returned in the
  `set-auth-token` header → SPA stores it and mints a JWT via `/auth/token`
  → calls the API with `Bearer <jwt>` exactly as today.
- **Sign-in with the existing MakerBay password:** SPA starts the Cognito
  social flow → Cognito hosted login → callback on `api.makerbay.app` links
  the account and sets a same-origin session cookie → `/auth-bridge` mints a
  one-time token → 302 to the SPA with `#ott=` → SPA exchanges it for a
  session token → bearer from then on. Cognito sends no email in this flow,
  so the SES sandbox is irrelevant.
- **Refresh:** session 7 days, refreshed daily; the SPA re-mints the JWT
  when it is within 60 s of expiry or on a 401.

## DynamoDB adapter

`packages/auth/src/adapter/`, built with Better Auth's `createAdapterFactory`.

| Item | pk | sk | gsi1 | gsi2 |
|---|---|---|---|---|
| any | `<model>#<id>` | `<model>` | | |
| user | | | `user#email#<lower>` | |
| session | | | `session#token#<token>` | `session#userId#<id>` / createdAt |
| account | | | `account#pa#<providerId>#<accountId>` | `account#userId#<id>` / providerId |
| verification | | | `verification#identifier#<identifier>` / createdAt | |
| passkey | | | `passkey#credentialID#<id>` | `passkey#userId#<id>` |
| organization | | | `organization#slug#<slug>` | |
| member | | | `member#org#<orgId>` / userId | `member#userId#<id>` |
| invitation | | | `invitation#org#<orgId>` / status | `invitation#email#<email>` |
| rateLimit | | | `rateLimit#key#<key>` | |

Every item also carries `gsi3pk = <model>`, `gsi3sk = createdAt` (the model
partition, for un-indexed queries and `findMany` with no `where`) and a `ttl`
epoch derived from `expiresAt` on session, verification and rateLimit.

Query planner: `eq` on `id` → GetItem; an AND-set covering a GSI key → Query
that GSI with the rest as a filter; otherwise Query the model partition with
a filter. `in` on `id` → BatchGet. `ends_with` and non-key sorts happen in
memory (documented). Uniqueness of `user.email` and `session.token` is
enforced with marker items in a transaction, because GSIs do not enforce it.

Tests: Better Auth's own `@better-auth/test-utils` suites (`normalTestSuite`,
`authFlowTestSuite`) against DynamoDB Local in Docker, or a throwaway table
in the account when Docker is not running.

## Phases

| Phase | Work | Days | Production? |
|---|---|---|---|
| 0 | Adapter + official suite | 1.5 | No |
| 1 | AuthFn, nested `AuthStack`, dual authorizer, OTP login page, Cognito upstream (hosted domain + confidential client), migration script, dark deploy behind `AUTH_PROVIDER` | 4 | No, flag off |
| 1b | Flip `AUTH_PROVIDER` in the stack and the SPA | 0.5 | Yes, reversible |
| 2 | Passkeys; organisations mapped `organization.id = tenantId` | 3 | Later |

Stack: ~10 resources in the nested stack, 3 in the parent (nested stack,
Cognito domain, second app client) → about 420 of 500.

## Risks

- **Revocation lag:** 15-minute JWT + 5-minute authorizer cache = up to 20
  minutes. Same property suspension already has. Documented, not lengthened.
- **Account linking:** OTP users are created verified, Cognito profiles are
  verified, `trustedProviders` is `['cognito']` only, and the profile mapper
  rejects `email_verified !== 'true'`.
- **Advisory cadence:** three high-severity Better Auth advisories in 2026.
  Pin `>= 1.6.11`, Dependabot on the package, monthly advisory check in the
  runbook, no `oidcProvider` or `mcp` plugins.
- **Cold start:** measure AuthFn at 512 MB.

## Founder decisions (defaults in bold)

1. First-party method: **passwordless code only for new users**; existing
   users also get the Cognito password button.
2. Cognito hosted domain during the redirect: **the free prefix domain**;
   `auth.makerbay.app` costs three resources and an ACM cert.
3. Cognito upstream: **kept permanently**.
4. Sessions: **Better Auth defaults (7 days / 1 day)**, not Cognito's 30.
5. Second upstream (WorkOS, Google): **phase 2**.
6. Revocation lag: **accept 20 minutes**.
7. Passkey relying party: `makerbay.app`, decided in phase 2.
8. Monthly advisory check: founder, or the agent on request.
