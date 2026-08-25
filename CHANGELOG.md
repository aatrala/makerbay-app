# Changelog

Every customer-visible change to MakerBay. The public version of this page is
at [makerbay.app/changelog](https://makerbay.app/changelog) and is generated
from this file, so this is the only place an entry gets written.

Format: one `##` heading per release, dated, optionally followed by a `> ` line
(**Headline** — one-sentence standfirst) used by the public page, then entries
tagged by area.
Areas are `platform`, or a module id (`assistant`, `contacts`, `requests`,
`booking`, `quotes`, `reviews`). Kinds are `Added`, `Changed`, `Fixed`,
`Security`.

## 2.21.0 - 2026-08-25

> **One Page screen, and invoices that watch your cash** — content, appearance and publishing in a single place beside the live preview; unpaid invoices tell you how overdue they are, in your own colours.

- Changed `presence` Edit page and Style merged into one "Page" screen:
  Content (photo, words), Appearance (layout, blocks, FAQ, colours,
  fonts, versions) and Publish (address, domain) as jumpable sections
  beside the always-visible live preview. Old Style links land in the
  right place.
- Added `quotes` Cash-flow at a glance: unpaid invoices show "due in 3d"
  or "12d overdue" in red, the invoice list gains unpaid/paid/draft tabs
  and an outstanding total, and an accepted quote offers Create invoice
  right in its header.
- Changed `quotes` Documents wear your colours: the bold invoice theme's
  band uses your accent on the customer page, and the theme preview
  renders YOUR business name, accent and top price-list lines instead of
  a stranger's mock.

## 2.20.0 - 2026-08-25

> **Genie's briefings grow buttons** — the diary and unpaid invoices arrive as cards you can act on, and your page can wear a scan-to-book QR.

- Added `genie` Briefing cards: when Genie checks your diary or your
  money, the answer carries compact cards - upcoming bookings with Done
  and Cancel, unpaid invoices with Chase. Every button proposes the same
  confirmation card as asking in words; nothing happens until you
  confirm.
- Added `presence` A scan-to-book QR on your public page (off by
  default): desktop visitors point their phone at it and land straight
  in your booking flow.
- Changed `presence` The editor uses the full width of a desktop screen;
  your business name - the page's big title - is now editable right in
  the Words card; the checklist leads with a progress bar and the single
  next step instead of a wall of items.

## 2.19.0 - 2026-08-25

> **Genie, priced and presented properly** — checkout says one product, the homepage shows all three plans, and the pricing page stops calling a live product "coming".

- Fixed `platform` Subscribing to Genie no longer shows "MakerBay Genie
  and 1 more": the usage-metered assistant-messages line now belongs to
  the Genie product itself, so checkout reads as one product with the
  same allowance and pricing.
- Changed `platform` The homepage pricing section shows all three plans
  including Genie at $99; the pricing page sells Genie as live (it is),
  with the right message allowance and the priority-support promise the
  ticket queue now actually honours; the roadmap moved Genie out of
  "Next" - it shipped.
- Fixed `platform` The assistant module page carried an old one-line
  footer; every marketing page now shares the same columned footer.

## 2.18.0 - 2026-08-25

> **Leads on your terms, a Genie you can scan, and pages you can see** — the contact form asks what you choose, Genie's briefings read like briefings, and every edit shows up beside the form as you work.

- Added `requests` "Leave your details" in the chat widget: a real contact
  form your visitors can always reach. Choose what it asks for - phone
  (optional/required/off), address, preferred time, and one question of
  your own (Trade). Answers land on the request and in your notification.
- Changed `requests` Lead notifications by plan: Trade workspaces get an
  email the moment each lead lands; Free workspaces get one summary every
  morning - a lead never disappears, it just waits for breakfast.
- Changed `genie` Briefings you can scan: bold names and amounts, real
  bullet lists, a full-height conversation, four standing quick buttons
  (Brief me / Diary / Money / Block time) with the rest behind +, and a
  "checked: bookings, money" line under each answer showing where the
  numbers came from.
- Changed `presence` The live preview now sits beside the editor on both
  the Edit and Style tabs - every save shows up instantly, with honest
  words about the ~5-minute visitor cache. Style choices show thumbnail
  previews of each layout.
- Changed `platform` Staff console: account dropdown with quick links and
  version, replacing the loose sign-out block. Missed-call settings now
  say plainly: the caller gets the SMS, the email is for you.

## 2.17.0 - 2026-08-25

> **Talk to us from where you work** — support and feedback live in your dashboard now: quick answers from the assistant, real tickets with a thread, and replies that reach your inbox too.

- Added `platform` Support & feedback under your account menu: ask the
  MakerBay assistant for instant how-to answers, or open a ticket
  (problem, question or idea). You see the whole thread in the dashboard,
  replies also arrive by email, and your own reply re-opens the
  conversation. Paid workspaces are answered first.
- Changed `platform` The staff console grew up: an overview dashboard
  (signups, subscriptions, open tickets, near-cap workspaces), a tickets
  queue, health flags on the workspace list, one search box that also
  understands email addresses, inline confirmations instead of browser
  popups, usage bars against real limits, an onboarding checklist per
  workspace, Stripe deep links, audit notes and filters, and its own
  colour so staff always know which app they are in.

## 2.16.0 - 2026-08-25

> **Your page, your way** — three page styles, drag-to-arrange blocks, an FAQ in your own words, colours and fonts, real sub-pages on your own domain, and version history that never loses a thing.

- Added `presence` Page styles: Simple (one page, free), and on Trade -
  Grow (blocks preview and expand into real sub-pages as content grows)
  and Storefront (a small site with Home / Services / FAQ / Reviews
  navigation). Sub-pages are real URLs on makerbay.app and on your custom
  domain, each with its own Google listing data.
- Added `presence` Blocks: drag to reorder and show/hide every section of
  your page (reordering with Trade). An owner-written FAQ (Trade) renders
  as an accordion and its own /faq page with FAQ structured data.
- Added `presence` Colours (Trade): background, text and button colours
  laid over your theme - buttons pick readable text automatically. Fonts
  (Genie): five curated pairings, loaded only when chosen.
- Added `presence` Version history (Trade): every save is kept (newest
  20) and restoring is one click - the restore itself becomes the newest
  version, so nothing is ever lost.

## 2.15.0 - 2026-08-25

> **The support console grows its second layer** — suppression lookups, a read-only conversation viewer, the staff audit log on screen, and scripted privacy export/delete.

- Added `platform` Staff console P1: check and clear an address on the SES
  suppression list (the usual answer to "my customer never got the email"),
  read a workspace's assistant conversations read-only for wrong-answer
  tickets (thumbs-down sessions first, every view audited), and browse the
  append-only staff audit log by month. Privacy requests get scripted,
  double-confirmed export and delete covering every table and the knowledge
  store.

## 2.14.0 - 2026-08-25

> **One page, several addresses — and a real browser behind the crawler** — extra addresses forward to your page, and JavaScript-built websites can finally be read into your knowledge base.

- Added `presence` Extra public addresses on paid plans: 3 in total on
  Trade, 5 on Genie. Each extra address 301-forwards to your main page -
  forwarding, never duplicating, so your page's search standing stays in
  one place. Managed under Your page → Your address; availability checks,
  the workspace picker and address changes all respect them.
- Fixed `assistant` Websites that draw their pages with JavaScript can now
  be added as knowledge: when a page's HTML comes back empty, a real
  headless browser runs the page and reads what it renders - after the
  existing markdown-twin and framework-data rescues. Pages that genuinely
  have no text still say so honestly.
- Fixed `platform` Error messages across the dashboard now show the
  server's actual explanation ("this page builds its content with
  JavaScript...") instead of a generic "could not be read".

## 2.13.0 - 2026-08-24

> **Genie for every workspace, and chips that know your business** — the copilot now shows up on every plan, quick questions adapt to what you actually run, and the help centre gets its own tab.

- Changed `genie` Genie appears in every workspace's sidebar now, not just
  the Genie plan - the taster (25 messages a month on Free, 250 on Trade)
  was already there; now the door is too. Quick chips adapt to the modules
  you run: bookings, unpaid invoices, money this week, reviews, block out
  time, your page.
- Changed `assistant` The chat widget's quick chips now include your own
  business: your top service by name and "Do you cover my area?" when you
  have service areas - answered by the assistant from your knowledge, not a
  canned card.
- Added `assistant` The help centre has its own tab under Assistant instead
  of hiding at the bottom of Behavior.
- Changed `presence` The custom-domain card now says up front when a plan
  does not include it, instead of refusing after you type your domain. The
  page preview got a cleaner header (device switch, Refresh, Open) and a
  proper phone frame.

## 2.12.0 - 2026-08-24

> **Support that answers on the first look** — staff can now find any account by email, see its whole state on one screen, send password resets, and pull the kill switch on abuse.

- Added `platform` Staff console: find a workspace by the customer's email
  address, a full account view (webhook health, payment onboarding, public
  page and domain state, who can log in), audited password resets that send
  Cognito's own code, and suspend/reinstate with enforcement everywhere -
  public pages and API access included. Every staff action is on the
  append-only audit log, reasons required.

## 2.11.0 - 2026-08-24

> **Your help centre, your words** — edit any article's title, description and category by hand, or have it rewritten from the content in one click.

- Added `assistant` An Article editor on every published knowledge source:
  change the title, one-line description and category your help centre
  shows, or tap "Rewrite with AI" to regenerate them from the content.
  Hand-written wording sticks until you say otherwise.

## 2.10.0 - 2026-08-24

> **A thumb nav for the ute, and a Genie taster for everyone** — Requests, Diary and Quotes one tap away on your phone, and every plan now includes enough Genie to feel what it is.

- Added `platform` A bottom navigation bar on phones: Requests (with a badge
  counting what waits on you), Diary, Quotes, and More for everything else.
  The screens a tradie opens between jobs, one thumb away.
- Added `genie` The Genie plan is live: $99 a month for everything in Trade
  plus 2,500 Genie messages. And every plan gets a taster - 25 messages a
  month on Free, 250 on Trade - so you can try the copilot before paying
  for it.

## 2.9.0 - 2026-08-24

> **Genie acts — but only when you say so** — send a quote, chase an invoice, cancel a booking or block out time from the chat, each behind a card only you can confirm.

- Added `genie` Genie can now do things, not just report them: send a quote or
  invoice, cancel or mark a booking done, block out your own time. Genie never
  acts on its own - it puts up a card saying exactly what will happen, and
  nothing happens until you tap confirm. Every confirmed action runs through
  the same code as the button on the screen, lands on the activity trail as
  "Genie, on the owner's confirmation", and leaves a receipt in the chat.
- Changed `genie` Genie now reads text inside your records (request messages,
  review text) as information only - it will tell you what a customer asked
  for, but never act on it without your card.

## 2.8.0 - 2026-08-24

> **Block out your own time** — school run, supplier visit, an afternoon off: block it in the diary and no customer can book over it.

- Added `booking` Block out time from the diary: pick a date, a from and to
  time and an optional private reason. Blocked windows never appear as free
  slots, the double-booking check refuses them, and they do not count against
  any monthly booking cap. Remove a block with one click when plans change.

## 2.7.0 - 2026-08-24

> **Document numbers that read like a real business** — quotes and invoices now start at 001 and can carry your own tag: SP-Q-001, SP-INV-001.

- Fixed `quotes` The first quote and the first invoice are now number 001, not
  002. Businesses already past their first documents keep every number they
  have - the fix only changes where a fresh series starts.
- Added `quotes` A document prefix in quote settings: up to six letters or
  digits, stamped on every quote and invoice number (SP makes SP-Q-001 and
  SP-INV-001). The label follows the document everywhere - the email subject,
  the customer's page, the Stripe statement line, the contact history and
  Genie's briefings.
- Changed `quotes` Document numbers are padded to three digits everywhere
  (Q-001, INV-042) instead of a mix of #1 and INV-0001.

## 2.6.0 - 2026-08-24

> **Meet Genie, and a dashboard that fits on one screen** — Genie answers questions about your whole business from a chat on your phone. And the sidebar shrank from thirty-six rows to twelve: one link per module, sub-pages as tabs.

- Added `genie` Genie v1: ask your business anything - what happened today,
  what is booked, who is waiting on you, what is unpaid - and get plain
  answers with the real numbers, from a mobile chat. Read-only by design in
  v1: acting on things ships next, behind your explicit confirmation, with
  every action on the activity trail. Rolling out with the Genie plan.
- Changed `platform` The dashboard sidebar: one link per module with icons,
  grouped Work then Grow, sub-pages as tabs above each screen, workspace
  items and the version behind the account popover. The test-billing badge
  stays; the live-mode banner is gone - live is just reality.
- Added `presence` QR codes: print-size downloads for your page, booking and
  chat links - on Your page and the Share screen. Plus a Share screen with
  per-network steps (WhatsApp, LinkedIn, Telegram, Facebook, Google) and
  one-tap share buttons.
- Fixed `presence` Connecting a custom domain: pasted URLs are cleaned up
  ("https://foo.com/" works), a removed domain can be connected again (the
  old setup now releases its claim properly), and swapping to a different
  domain is a single button instead of a scary remove.
- Fixed `assistant` The booking and review forms inside the chat widget laid
  out sideways; they stack properly everywhere now.
- Added `assistant` The chat surface shows who you are talking to - business
  name, photo and live open-hours state - with quick-answer buttons for
  services, prices, hours and contact that cost no waiting and no AI.

## 2.5.0 - 2026-08-24

> **One price for everything, and a trail of what happened** — Pricing is now two honest tiers: Free runs your business online, Trade at $29 switches everything on. And every workspace gains an Activity feed - one plain sentence for everything that happens.

- Changed `platform` Pricing moved from modules to tiers: Free (your page,
  quotes, invoices, payments, inbox) and Trade at $29/month with unlimited
  bookings, reviews, quotes and invoices, 2,000 assistant messages and your
  own domain. Same prices worldwide, in USD. Existing subscribers got
  strictly more for the same money. Annual at $290 - two months free - and
  annual plans pause politely at the allowance instead of billing overage.
- Added `platform` The Activity feed: everything that happens in your
  workspace - bookings, payments, review asks, settings changes - as one
  plain sentence each, kept for 13 months. Traceability, not telemetry.
  This is also the foundation Genie will stand on.
- Changed `platform` The roadmap is now an honest Now / Next / Later board -
  every Next item carries the bar it must clear, every Later item its
  trigger - and the changelog became this timeline, with a headline per
  release.

## 2.4.0 - 2026-08-24

> **Get paid, and an assistant that knows your business** — Card payment lands on invoices and quote deposits, straight to your bank with no platform fee. And the assistant now answers prices, hours and service areas before you upload a single document.

- Added `payments` Get paid is live: connect your bank once through Stripe
  and your unpaid invoices grow a Pay online button, and accepted quotes can
  ask for a deposit percentage on the spot. Money goes straight to your
  account - MakerBay never holds funds and adds no fee on top of Stripe's.
  The invoice marks itself paid when the money lands; the webhook is the
  source of truth, never the button press. Full refunds from the dashboard.
- Changed `assistant` The assistant now knows what your workspace knows:
  services, prices, opening hours, service areas and contact details answer
  correctly before you upload a single document, and it points customers at
  the real Book a time button. The default greeting no longer talks about
  "docs".
- Changed `assistant` The chat surface matches your page: it uses your page
  accent colour, and shows a Book a time button in the header when Bookings
  is on.
- Added `platform` MakerBay's own assistant now answers on makerbay.app -
  the product, demonstrated by the product.

## 2.3.0 - 2026-08-24

> **Addresses you can say out loud** — Your public address is now your business name, editable with live availability checking. Your page gained three styles, your accent colour, and in-page booking and chat.

- Changed `platform` Workspace addresses are now memorable: a new workspace
  gets its clean business name (smith-plumbing, not smith-plumbing-x4x), and
  under Workspace → Settings you can edit it, with live availability checking
  and a plain warning that old links stop working.
- Changed `presence` Your page has a new look: three switchable styles
  (Fresh, Warm, Bold), your own accent colour, a photo-led hero, service and
  review cards, and a today-highlighted hours grid - all mobile-first.
- Added `presence` Ask-a-question and Book-a-time now open in a panel on the
  page itself, so a visitor is never sent away mid-thought. A floating ask
  button rides along as they scroll.
- Added `presence` A live desktop-and-phone preview of your real page in the
  dashboard, next to the theme controls.
- Added `presence` A page checklist: the full path from "page exists" to
  "page earns work" - intro, photo, priced service, hours, booking, reviews,
  Google review link - each step linked to where it is done.
- Added `quotes` Currency is now yours to set (AUD, INR, USD and more), and
  the invoice theme has a live preview in settings. The page and quote
  surfaces show prices in your currency everywhere.
- Fixed `assistant` Importing a JavaScript-rendered website no longer fails
  silently to zero pages: the importer now tries the site's markdown twins
  and embedded page data, offers the site's llms.txt as the best single
  source, and - when nothing is readable - says exactly why and what works
  instead.
- Changed `platform` The marketing site: simpler header, structured footer,
  a categorised FAQ, and real product screenshots including a live example
  page you can open and book.

## 2.2.0 - 2026-08-24

> **Reviews, reminders, and invoices** — Mark a job done and the right things happen on their own: one polite review ask, reminder emails that cut no-shows, and accepted quotes that become printable invoices in one click.

- Added `reviews` Reviews is live: after a completed booking the customer gets
  one polite ask, leaves stars and words on a page in your name, and the
  published reviews appear on your MakerBay page. You can hide a review or
  bring it back - never edit it. Every respondent is offered your Google
  review link, whatever they scored: gating reviews breaks Google's rules and
  we will not build it.
- Added `booking` Reminders that stop no-shows: a reminder email the day
  before (or two hours before, for same-day bookings) with the same cancel
  link. Cancelled bookings never get one - the reminder re-checks the diary
  before it sends.
- Added `quotes` Quote revisions: a revision is a fresh quote with a new
  number, and what the customer already accepted, declined or let lapse stays
  exactly as it was. A replaced quote's page points forward to the current one.
- Added `quotes` Simple invoices: one click turns an accepted quote into a
  numbered invoice - same agreed lines, a due date, your payment details and a
  printable page in a choice of three themes. Mark it paid when the money
  lands; a paid invoice never changes. Bookkeeping and tax accounting stay in
  your accounting software, as promised.
- Added `presence` Presence Pro custom domains: connect a domain you own, add
  two DNS records, and your page serves at yourbusiness.com.au with its own
  certificate. The free makerbay.app page stays either way.
- Added `presence` Published reviews now appear on your page - the words your
  customers actually wrote.
- Changed `platform` Modules now talk to each other through events: a
  completed booking raises one event, and whichever review surface you run -
  Reviews, or the Get found Google-link ask - answers it. One ask per
  completion, never both.

## 2.1.0 - 2026-08-24

> **Get found, and calls that rescue themselves** — A guided Google Business Profile checklist, and missed-call rescue: the caller gets your booking link by text while their voicemail lands transcribed in your inbox.

- Added `visibility` Get found is live and free: a guided checklist that gets
  your Google Business Profile right in about twenty minutes, and review
  requests sent at the moment a customer is most likely to say yes - one email,
  once, right after the job is done. Ask from a contact's page, or let a
  completed booking ask automatically.
- Added `voice` Missed-call rescue is built and proven: an unanswered call
  forwards to your rescue number, the caller hears a greeting in your name and
  gets a text with your booking link while they listen, and their voicemail is
  written out with the job, address and urgency pulled into your Requests
  inbox. A booking that follows is tracked back to the rescued call - the
  conversion number this whole category never publishes.
- Added `voice` Deliberately not a talking robot. Every conversational AI
  receptionist measured on real calls answers over a second late and roughly a
  third of callers say they would hang up on one; the transcript-and-text-back
  design does the job with none of that risk.
- Added `requests` Missed calls appear in the inbox alongside handoffs, leads
  and feedback, with the same reply tools.

## 2.0.0 - 2026-08-24

> **Every workspace gets a real page** — Services, live hours, a photo and buttons that actually book and answer, at makerbay.app/p/your-business. Hidden from search engines until genuinely complete.

- Added `presence` Every workspace now has a real web page at
  makerbay.app/p/{slug}: services and prices from Bookings, opening hours with
  a live open-or-closed status in the business timezone, a photo, and buttons
  that book a real slot or ask the assistant. Edit it from Your page in the
  dashboard.
- Added `presence` The page is honest with search engines. It stays hidden
  until it has an intro, a photo and a priced service, and if you have your own
  website it links there and stays out of results entirely - we never compete
  with you for your own name.
- Added `booking` Customers can now actually book. The public booking page
  walks service, day, time and details, refuses a slot taken a second earlier,
  and the confirmation email carries a private cancel link that frees the slot.
- Added `quotes` The quote link customers receive now opens a real page: every
  line and total, accept or decline with one tap, and a clear state once it is
  settled or expired.
- Fixed `booking` Switching the Bookings module on had never worked - the
  module catalogue predated it. Enabling it now grants a free tier of 20
  bookings a month.
- Fixed `presence` A photo upload that failed part-way no longer leaves the
  page pointing at a missing image; the photo is verified in storage before it
  counts.

## 1.11.0 - 2026-08-24

- Added `platform` The roadmap now shows where the product is going: a page per
  business, being findable by service and suburb, and a voice agent that
  answers when you cannot. What each one will and will not do is written down
  before any of it is built.

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
