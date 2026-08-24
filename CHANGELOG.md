# Changelog

Every customer-visible change to MakerBay. The public version of this page is
at [makerbay.app/changelog](https://makerbay.app/changelog) and is generated
from this file, so this is the only place an entry gets written.

Format: one `##` heading per release, dated, with entries tagged by area.
Areas are `platform`, or a module id (`assistant`, `contacts`, `requests`,
`booking`, `quotes`, `reviews`). Kinds are `Added`, `Changed`, `Fixed`,
`Security`.

## 1.10.0 - 2026-08-24

- Changed `platform` Contacts, Requests and Quotes are free on every workspace,
  forever. You pay for the AI assistant and Bookings, and only for what you
  switch on.
- Added `platform` A pricing page that says which modules cost money and which
  do not, generated from the same manifests as everything else.
- Fixed `platform` The changelog page rendered its releases with no entries.
  Git checks the file out with CRLF on Windows and a JavaScript regex does not
  match a carriage return, so every entry silently failed to parse. The build
  now refuses to publish an empty release.
- Fixed `platform` Email failures caused by the SES sandbox now say so plainly
  instead of showing a raw AWS error.

## 1.9.0 - 2026-08-24

- Added `requests` Requests is live. When the assistant cannot answer, the
  customer leaves their details in the same chat window, you get an email, and
  the thread waits in an inbox you can reply from.
- Added `booking` Bookings is live. Publish your services and hours, and
  customers book themselves into slots you can actually work - buffers, lead
  time and closures all respected, in your timezone.
- Added `booking` A customer who cannot make it cancels from a private link in
  their confirmation email, which frees the slot instead of a no-show.
- Added `quotes` Quotes is live. Price a job from a saved price list, send a
  link, and the customer accepts on their phone. An accepted quote is fixed:
  changing one means writing a new one.
- Added `platform` Unit tests. Slot computation, money arithmetic, CSV parsing
  and contact matching are covered - 56 tests, no AWS needed to run them.
- Fixed `platform` First sign-in to the staff console. A new account is issued
  a temporary password and Cognito refuses to authenticate until it is
  replaced; the console had no screen for that, so a new account could never
  get in.

## 1.8.0 - 2026-08-24

- Added `contacts` Contacts is live on every workspace: one customer list with
  a status, a note and a history, filled in by your other modules instead of by
  hand. Import the spreadsheet you already keep, export it whenever you like.
- Added `contacts` The same person arriving from two places stays one person.
  Matching is on email or phone, so a booking and a quote land on one record.
- Added `assistant` A public help centre at help.makerbay.app/{slug}. Publish
  any source you have already uploaded as a page Google can index, with a
  sitemap you can submit to Search Console. Off by default, and each article is
  published individually.
- Added `assistant` Citations now carry the passage the answer came from, not
  just the file name, with a link to the original page where there is one.
- Added `platform` Email sending on our own domain, with DKIM signing and a
  separate MAIL FROM subdomain, ready for Requests.
- Fixed `platform` A billing type error that shipped because CDK bundles Lambda
  code without typechecking it. `npm run typecheck` now covers every Lambda.

## 1.7.0 - 2026-08-23

- Added `platform` A staff console at admin.makerbay.app: workspace list,
  effective entitlements, and granting or revoking a module without a payment.
  Sign-in requires an authenticator code, and every grant needs a reason that
  is written to an append-only audit log.
- Added `platform` Billing now shows whether Stripe is actually reaching us -
  when the last event arrived and in which mode - and warns when a live
  workspace is still receiving test-mode events, which otherwise stays silent
  until an invoice goes missing.

## 1.6.0 - 2026-08-23

- Changed `platform` Module dashboards now live with their module rather than
  in the shell. Adding a module is an import and an array entry; the shell
  knows nothing about what any module does.
- Added `platform` A shared UI kit that module screens build on, so the second
  module inherits the design system instead of re-implementing it.

## 1.5.0 - 2026-08-23

- Added `platform` Module manifests now carry their own marketing copy, so
  every module page, the homepage grid and the roadmap are generated from one
  source instead of being written out three times.
- Added `platform` A public changelog at makerbay.app/changelog.
- Added `platform` A public roadmap at makerbay.app/roadmap, ordered by what
  each module depends on rather than by guesswork.
- Added `contacts` Contacts enters development as part of the platform rather
  than as a paid module. Every other module writes customer records to it, so
  gating it behind an entitlement would let modules drift into keeping
  separate, unjoinable customer lists.

## 1.4.0 - 2026-08-23

- Added `platform` A written design system at `docs/design-guidelines.md`
  that every future module inherits.
- Changed `assistant` The dashboard was rebuilt on it: empty states that name
  the next action, loading skeletons instead of blank screens, and error
  messages written as sentences rather than machine codes.
- Added `assistant` A new workspace now lands on Knowledge rather than an
  empty Playground, because an assistant with nothing to read cannot answer
  anything.
- Fixed `assistant` The dashboard is usable on a phone: the sidebar collapses
  to a menu and wide tables scroll inside their card instead of pushing the
  page sideways.
- Changed `platform` The marketing site and the dashboard now share one set of
  design tokens, differing only in density.

## 1.3.0 - 2026-08-22

- Added `assistant` Knowledge sources can be previewed: the extracted text,
  the original file, the size and when it was added.
- Added `assistant` Web pages can be refreshed in place when your site
  changes, without removing and re-adding the source.
- Added `platform` Staff grant endpoint, so entitlements can be granted
  without a payment - for pilots, comps and support fixes.
- Security `platform` Grants are stored as items rather than overwritten
  fields, so a Stripe webhook can no longer wipe a manually granted plan.

## 1.2.0 - 2026-08-22

- Added `assistant` Learn from your website: point it at a domain and it finds
  the pages worth reading through sitemap.xml, llms.txt or page links.
- Security `assistant` URL fetching allows only public web addresses. Private
  network ranges are refused, and the check runs again on every redirect hop.
- Added `assistant` Pages that come back nearly empty are refused with an
  explanation rather than silently stored.

## 1.1.0 - 2026-08-21

- Added `platform` A hosted MCP server at mcp.makerbay.app, so Claude, Cursor
  and other agent tools can query your knowledge directly.
- Added `assistant` Streaming answers. First words now appear in under a
  second instead of after the whole answer is written.

## 1.0.0 - 2026-08-20

- Added `assistant` The AI assistant: answers customer questions from your own
  documents, as a website widget, a shareable page or an API.
- Added `platform` Workspaces, sign-in, per-module entitlements, usage
  metering and Stripe billing with a free plan and pay-as-you-go overage.
