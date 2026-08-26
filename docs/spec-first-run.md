# First-run experience (issue 74)

Approved internally 2026-08-26 after an agent consult; built the same
day. Founder comments on the live build.

## Shape

A dedicated `/home` screen owned by `web/` (the shell knows nothing
about modules and that stays true - Home talks only to public module
APIs). It is the landing page until the six steps are done or the
owner hides it, then landing reverts to the first module and Home
stays reachable via the account menu ("Getting started") forever.

Six steps, each a real signal from an existing endpoint:
1. Add a service with a price - /v1/booking/services length
2. Set working hours - booking config hours non-empty
3. Show the assistant a website/document - /v1/assistant/sources length
4. Publish your page - presence config published
5. Build the price list - /v1/quotes/items length
6. Google review link - visibility config reviewLink

Rendered in the presence-checklist pattern (progress bar + "Next:" +
one CTA + full list). Dismissal is `mb.setupDone.<tenantId>` in
localStorage (per-device accepted for a solo owner; server boolean is
the upgrade path). Also: onboarding no longer routes to Knowledge
(assistantFirstRun retired), a "see the demo" line links
demo.makerbay.app, the reviews empty state points here, and the
presence checklist's stale /booking/settings link is fixed to
/booking/hours.

Not in v1 (deliberate): tours, videos, sample-data seeding, a
composite API, server-persisted dismissal.
