/**
 * Renders every email the product can send into one reviewable page.
 *
 *   npx tsx scripts/email-gallery.mts <out.html>
 *
 * Driven off the real template functions, so the gallery cannot drift from
 * what actually sends. If a template is added and not listed here, the script
 * fails rather than quietly showing a short list - a review page that silently
 * omits an email is worse than no review page (issue 132).
 */
import { writeFileSync } from 'node:fs'
import * as customer from '../packages/email/src/templates/customer'
import * as owner from '../packages/email/src/templates/owner'
import { authEmail } from '../packages/email/src/templates/auth'
import { PLATFORM } from '../packages/email/src/platform'

const brand = { name: 'Newtown Plumbing', accent: '#1d4ed8' }
const contact = { phone: '0412 555 908', email: 'sam@newtownplumbing.com.au' }
const c = { brand, contact }
const B = 'Newtown Plumbing'
const UNSUB = 'https://api.makerbay.app/v1/public/unsubscribe?t=8f3a1c7e9b2d4a6f'

interface Entry {
  name: string
  audience: 'Customer' | 'Owner' | 'Security'
  trigger: string
  mail: { subject: string; html: string; text: string }
}

const E = (
  name: string,
  audience: Entry['audience'],
  trigger: string,
  mail: Entry['mail'],
): Entry => ({ name, audience, trigger, mail })

const ENTRIES: Entry[] = [
  // ── To the homeowner ────────────────────────────────────────────────────
  E('Quote sent', 'Customer', 'The business sends a quote from the dashboard.',
    customer.quoteSent({
      ...c, customerName: 'Marie', label: 'Q-014', total: '$368.50',
      validUntil: '26 September 2026',
      url: 'https://quote.makerbay.app/newtown-plumbing/Q-014/8f3a1c7e',
      lines: [
        { description: 'Replace kitchen mixer tap', quantity: '2 hours', amount: '$280.00' },
        { description: 'Mixer tap, chrome', quantity: '1', amount: '$88.50' },
      ],
    })),
  E('Invoice sent', 'Customer', 'The business sends an invoice, or a quote is accepted with a deposit.',
    customer.invoiceSent({
      ...c, customerName: 'Marie', label: 'INV-042', total: '$1,240.00',
      due: '12 September 2026',
      url: 'https://invoice.makerbay.app/newtown-plumbing/INV-042/2b9d4e1a', payable: true,
    })),
  E('Invoice sent, already paid', 'Customer', 'The same invoice when the deposit covered it, or it was paid in person. No pay button.',
    customer.invoiceSent({
      ...c, customerName: 'Marie', label: 'INV-042', total: '$1,240.00',
      due: '12 September 2026',
      url: 'https://invoice.makerbay.app/newtown-plumbing/INV-042/2b9d4e1a', payable: false,
    })),
  E('Booking confirmed', 'Customer', 'A customer books a time on the business booking page.',
    customer.bookingConfirmed({
      ...c, service: 'Blocked drain', when: 'Tuesday 3 September, 9:00am',
      cancelUrl: 'https://chat.makerbay.app/booking/cancel?slug=newtown-plumbing&token=7c2e',
    })),
  E('Booking confirmed, deposit taken', 'Customer', 'The same confirmation when the service asks for a deposit.',
    customer.bookingConfirmed({
      ...c, service: 'Blocked drain', when: 'Tuesday 3 September, 9:00am', deposit: '$50.00',
      cancelUrl: 'https://chat.makerbay.app/booking/cancel?slug=newtown-plumbing&token=7c2e',
    })),
  E('Booking reminder', 'Customer', 'The day before the appointment.',
    customer.bookingReminder({
      ...c, service: 'Blocked drain', when: 'tomorrow at 9:00am',
      cancelUrl: 'https://chat.makerbay.app/booking/cancel?slug=newtown-plumbing&token=7c2e',
    })),
  E('Booking cancelled', 'Customer', 'The business cancels the appointment.',
    customer.bookingCancelled({ ...c, service: 'Blocked drain', when: 'Tuesday 3 September' })),
  E('Review request', 'Customer', 'After a completed job. The only optional customer email.',
    customer.reviewAsk({
      ...c, message: 'Thanks for having us out on Tuesday.',
      url: 'https://g.page/r/newtown-plumbing/review', unsubscribeUrl: UNSUB,
    })),
  E('Reply to an enquiry', 'Customer', 'The business answers a question from the contact form.',
    customer.requestReply({
      ...c, subject: 'Leaking tap in the ensuite',
      body: 'Thanks for getting in touch. We can come Thursday morning between 8 and 10 if that suits. It is usually a worn washer and takes about half an hour.',
    })),

  // ── To the business owner ───────────────────────────────────────────────
  E('Quote accepted', 'Owner', 'A customer accepts a quote.',
    owner.quoteAnswered({
      businessName: B, customerName: 'Marie', label: 'Q-014', total: '$368.50',
      accepted: true, quoteUrl: 'https://app.makerbay.app/quotes/01J8',
    })),
  E('Quote declined', 'Owner', 'A customer declines a quote.',
    owner.quoteAnswered({
      businessName: B, customerName: 'Marie', label: 'Q-014', total: '$368.50',
      accepted: false, quoteUrl: 'https://app.makerbay.app/quotes/01J8',
    })),
  E('Deposit paid', 'Owner', 'A customer pays a deposit on an accepted quote.',
    owner.depositPaid({
      businessName: B, customerName: 'Marie', label: 'Q-014', amount: '$92.00',
      url: 'https://app.makerbay.app/quotes/01J8',
    })),
  E('New booking', 'Owner', 'Someone books a time. Paid workspaces get this instantly.',
    owner.newBooking({ businessName: B, who: 'Marie Chen', service: 'Blocked drain', when: 'Tuesday 3 September, 9:00am' })),
  E('Booking cancelled by customer', 'Owner', 'A customer cancels their own appointment.',
    owner.bookingCancelledByCustomer({ businessName: B, who: 'Marie Chen', service: 'Blocked drain', when: 'Tuesday 3 September' })),
  E('New enquiry', 'Owner', 'Someone sends a message through the page or the assistant.',
    owner.newRequest({ businessName: B, who: 'Marie Chen', kind: 'enquiry', message: 'Leaking tap in the ensuite, getting worse.' })),
  E('Missed call', 'Owner', 'A call comes in and is not answered.',
    owner.missedCall({ businessName: B, caller: '0412 555 908', texted: true, anonymous: false })),
  E('Missed call, withheld number', 'Owner', 'The same alert when the caller withheld their number, so there is nobody to ring back.',
    owner.missedCall({ businessName: B, caller: '', texted: false, anonymous: true })),
  E('Deposit on a lapsed booking', 'Owner', 'A deposit arrives for a booking that has already expired.',
    owner.depositOnLapsedBooking({ businessName: B, service: 'Blocked drain', amount: '$50.00' })),
  E('Notifications are broken', 'Owner', 'The notification address the business relies on starts bouncing.',
    owner.notificationsBroken({ businessName: B, bounced: 'sam@newtownplumbing.com.au' })),
  E('Daily digest', 'Owner', 'Free workspaces, once a morning. Optional, and carries an unsubscribe.',
    owner.requestsDigest({
      businessName: B, unsubscribeUrl: UNSUB,
      items: [
        { who: 'Marie Chen', summary: 'Leaking tap in the ensuite' },
        { who: '0498 221 007', summary: 'Quote for a hot water service' },
      ],
    })),
  E('Support reply', 'Owner', 'A staff member answers a support ticket.',
    owner.ticketReply({
      businessName: B, subject: 'Invoice did not reach my customer',
      reply: 'That address bounced on the 24th, so we stopped sending to it to protect your sending reputation. I have cleared it now. Worth checking the spelling with Marie before you resend.',
    })),

  // ── Security ────────────────────────────────────────────────────────────
  E('Confirm your email', 'Security', 'Signing up. Built into the user pool at deploy time.', authEmail('verify')),
  E('Reset your password', 'Security', 'Requesting a password reset.', authEmail('reset')),
  E('Your sign-in code', 'Security', 'Signing in with a code instead of a password.', authEmail('signin')),
]

/**
 * Every template function this gallery accounts for.
 *
 * Checked against what the modules actually export, so adding a template
 * without adding it here fails the build instead of quietly producing a
 * gallery that is one email short. That is the whole failure mode this script
 * exists to prevent: the support reply was missing from the review for months
 * because nothing compared the list to the code.
 */
const COVERED = new Set([
  'quoteSent', 'invoiceSent', 'bookingConfirmed', 'bookingReminder',
  'bookingCancelled', 'reviewAsk', 'requestReply',
  'quoteAnswered', 'depositPaid', 'newBooking', 'bookingCancelledByCustomer',
  'newRequest', 'missedCall', 'depositOnLapsedBooking', 'notificationsBroken',
  'requestsDigest', 'ticketReply',
])

const exported = [...Object.keys(customer), ...Object.keys(owner)]
  .filter((k) => typeof (customer as never)[k] === 'function' || typeof (owner as never)[k] === 'function')
const missing = exported.filter((k) => !COVERED.has(k))
const stale = [...COVERED].filter((k) => !exported.includes(k))
if (missing.length || stale.length) {
  console.error('Gallery is out of step with the templates.')
  if (missing.length) console.error('  Not in the gallery:', missing.join(', '))
  if (stale.length) console.error('  Listed but no longer exported:', stale.join(', '))
  process.exit(1)
}

import { esc } from '../packages/email/src/render'

const TONE: Record<Entry['audience'], string> = {
  Customer: 'cust', Owner: 'own', Security: 'sec',
}

const card = (e: Entry, i: number): string => `
<article class="card" id="t${i}">
  <header class="card-head">
    <div class="card-id">
      <span class="chip ${TONE[e.audience]}">${e.audience}</span>
      <h3>${esc(e.name)}</h3>
    </div>
    <p class="trigger">${esc(e.trigger)}</p>
  </header>
  <dl class="meta">
    <dt>Subject</dt><dd class="subj">${esc(e.mail.subject)}</dd>
  </dl>
  <div class="preview">
    <iframe title="${esc(e.name)}" loading="lazy" sandbox="allow-same-origin"
      srcdoc="${esc(e.mail.html)}"></iframe>
  </div>
  <details>
    <summary>Plain text version</summary>
    <pre>${esc(e.mail.text)}</pre>
  </details>
</article>`

const counts = {
  Customer: ENTRIES.filter((e) => e.audience === 'Customer').length,
  Owner: ENTRIES.filter((e) => e.audience === 'Owner').length,
  Security: ENTRIES.filter((e) => e.audience === 'Security').length,
}

const html = `<title>Every Email MakerBay Sends</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,600&family=Public+Sans:wght@400;500;700&display=swap">
<style>
:root {
  --ground: #fbfaf9; --panel: #ffffff; --ink: #1c1917; --body: #57534e;
  --dim: #8b8580; --line: #e7e5e4; --line-soft: #f0eeec;
  --cust: #1d4ed8; --cust-bg: #eff4ff;
  --own: #c2410c; --own-bg: #fff5ed;
  --sec: #3f6212; --sec-bg: #f2f8e8;
}
:root:not([data-theme="light"]) { }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #16150f; --panel: #211f1a; --ink: #f5f2ec; --body: #c4bdb2;
    --dim: #8d8579; --line: #35322a; --line-soft: #2a2721;
    --cust: #93b4ff; --cust-bg: #1a2340; --own: #f3a06a; --own-bg: #3a2114;
    --sec: #b3d67a; --sec-bg: #26310f;
  }
}
:root[data-theme="dark"] {
  --ground: #16150f; --panel: #211f1a; --ink: #f5f2ec; --body: #c4bdb2;
  --dim: #8d8579; --line: #35322a; --line-soft: #2a2721;
  --cust: #93b4ff; --cust-bg: #1a2340; --own: #f3a06a; --own-bg: #3a2114;
  --sec: #b3d67a; --sec-bg: #26310f;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--ground); color: var(--body);
  font: 400 16px/1.6 'Public Sans', ui-sans-serif, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 900px; margin: 0 auto; padding: 0 24px; }
h1, h2, h3 { color: var(--ink); font-family: 'Newsreader', Georgia, serif; font-weight: 600; text-wrap: balance; }
.masthead { padding: 68px 0 30px; border-bottom: 1px solid var(--line); }
h1 { font-size: 46px; line-height: 1.08; letter-spacing: -0.015em; margin: 0 0 14px; }
.lede { font-size: 18px; max-width: 60ch; margin: 0; }
.tally { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 26px; }
.tally span {
  font-size: 13px; font-weight: 500; padding: 5px 12px; border-radius: 100px;
  border: 1px solid var(--line);
}
.note {
  background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--own);
  border-radius: 12px; padding: 20px 22px; margin: 34px 0 0; font-size: 15px;
}
.note strong { color: var(--ink); }
h2.sec {
  font-size: 13px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase;
  font-family: 'Public Sans', sans-serif; color: var(--dim);
  margin: 64px 0 20px; padding-bottom: 10px; border-bottom: 1px solid var(--line);
}
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  padding: 22px 22px 8px; margin-bottom: 22px;
}
.card-head { margin-bottom: 14px; }
.card-id { display: flex; align-items: center; gap: 11px; flex-wrap: wrap; }
.card h3 { font-size: 21px; margin: 0; letter-spacing: -0.01em; }
.chip {
  font: 700 10.5px/1 'Public Sans', sans-serif; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 5px 9px; border-radius: 5px; white-space: nowrap;
}
.chip.cust { color: var(--cust); background: var(--cust-bg); }
.chip.own { color: var(--own); background: var(--own-bg); }
.chip.sec { color: var(--sec); background: var(--sec-bg); }
.trigger { font-size: 14.5px; color: var(--dim); margin: 8px 0 0; }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 16px; }
.meta dt { font-size: 11px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--dim); padding-top: 3px; }
.meta dd { margin: 0; }
.subj { color: var(--ink); font-weight: 500; }
.preview { border: 1px solid var(--line-soft); border-radius: 10px; overflow: hidden; background: #fff; }
.preview iframe { display: block; width: 100%; height: 520px; border: 0; }
details { margin: 12px 0 14px; }
summary {
  cursor: pointer; font-size: 13px; font-weight: 500; color: var(--dim);
  padding: 6px 0; list-style: revert;
}
summary:hover { color: var(--ink); }
details pre {
  font: 400 12.5px/1.65 ui-monospace, 'Cascadia Code', Consolas, monospace;
  background: var(--ground); border: 1px solid var(--line-soft); border-radius: 8px;
  padding: 16px; margin: 8px 0 0; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  color: var(--body);
}
footer { border-top: 1px solid var(--line); margin-top: 60px; padding: 26px 0 70px; font-size: 14px; color: var(--dim); }
@media (max-width: 640px) {
  h1 { font-size: 33px; }
  .masthead { padding-top: 44px; }
  .card { padding: 18px 16px 6px; }
  .preview iframe { height: 440px; }
}
</style>

<div class="wrap">
  <header class="masthead">
    <h1>Every email MakerBay sends</h1>
    <p class="lede">
      All ${ENTRIES.length} versions of the ${COVERED.size + 3} templates,
      rendered by the same code that sends them. Where a template changes its
      wording depending on the situation, both versions are here. Nothing is a
      mockup: if it reads wrong on this page, it reads wrong in the inbox.
    </p>
    <div class="tally">
      <span>${counts.Customer} to the homeowner</span>
      <span>${counts.Owner} to the business owner</span>
      <span>${counts.Security} security</span>
    </div>
    <div class="note">
      <strong>What changed in this version.</strong> Every footer now names
      ${PLATFORM.legalEntityName} at ${PLATFORM.postalAddress}, replacing a
      placeholder company that did not exist. The customer footer also names
      both parties and the relationship between them, which is what Canada&rsquo;s
      anti-spam law requires when you send on somebody else&rsquo;s behalf, and
      what stops the address reading as the tradesperson&rsquo;s own. The support
      reply is new to this list: it was the last email still assembled by hand
      rather than from a template, so it never appeared in a review.
    </div>
  </header>

  <h2 class="sec">To the homeowner &middot; wears the business, never MakerBay</h2>
  ${ENTRIES.filter((e) => e.audience === 'Customer').map(card).join('')}

  <h2 class="sec">To the business owner &middot; wears MakerBay</h2>
  ${ENTRIES.filter((e) => e.audience === 'Owner').map(card).join('')}

  <h2 class="sec">Security &middot; no links to click, no preferences offered</h2>
  ${ENTRIES.filter((e) => e.audience === 'Security').map(card).join('')}

  <footer>
    Generated from the template source by <code>scripts/email-gallery.mts</code>.
    Sample business, customer and amounts are invented; the wording, layout and
    footers are exactly what sends.
  </footer>
</div>

<script>
// Size each preview to its content so nothing is cut off mid-sentence. Falls
// back to the fixed CSS height if the frame is not readable.
for (const f of document.querySelectorAll('.preview iframe')) {
  const fit = () => {
    try {
      const h = f.contentDocument?.body?.scrollHeight
      if (h && h > 80) f.style.height = (h + 24) + 'px'
    } catch (e) { /* keep the CSS height */ }
  }
  f.addEventListener('load', fit)
  fit()
}
</script>
`

const out = process.argv[2]
if (!out) { console.error('Usage: npx tsx scripts/email-gallery.mts <out.html>'); process.exit(1) }
writeFileSync(out, html, 'utf8')
console.log(`gallery written: ${ENTRIES.length} templates -> ${out}`)
