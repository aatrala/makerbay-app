import type { Block, EmailBrand, EmailDoc } from '../blocks'
import { customerFooter } from '../footers'
import { renderEmail } from '../render'

/**
 * Mail to the tradesperson's CUSTOMER (issue 94).
 *
 * These wear the business's name and colour, never MakerBay's. A homeowner who
 * booked Southside Plumbing has never heard of us: a message signed by one
 * company and sent by another is the shape of a phishing email, and it is the
 * From line that a phone shows in the inbox list before anything else.
 *
 * Every one of these is transactional - the customer asked for it by booking,
 * by requesting a quote, or by having work done. The single exception is the
 * review ask, which is the only template here that carries an unsubscribe.
 *
 * All of them are pure: everything they need arrives as arguments, so the
 * wording can be asserted without a database. Same shape as
 * presence/api/src/render.ts.
 */

export interface CustomerContact {
  phone?: string
  email?: string
}

interface Common {
  brand: EmailBrand
  contact: CustomerContact
}

/** The one line under the rule saying why this arrived. Required, always. */
const REASONS = {
  quote: 'You are getting this because you asked for a quote.',
  invoice: 'You are getting this because work was done for you.',
  booking: 'You are getting this because you booked a time.',
  reminder: 'You are getting this because you have a booking coming up.',
  cancelled: 'You are getting this because your booking was cancelled.',
  review: 'You are getting this because we finished a job for you.',
  reply: 'You are getting this because you sent a message.',
} as const

const doc = (
  c: Common,
  subject: string,
  preheader: string,
  heading: string,
  blocks: Block[],
  unsubscribe?: { url: string; mailto: string },
): EmailDoc => ({
  brand: c.brand,
  subject,
  preheader,
  heading,
  blocks,
  ...(unsubscribe ? { unsubscribe } : {}),
})

const render = (d: EmailDoc, c: Common, reason: keyof typeof REASONS) =>
  renderEmail(d, customerFooter(d.brand.name, c.contact, REASONS[reason]))

// ── Quote ────────────────────────────────────────────────────────────────

export interface QuoteMail extends Common {
  customerName?: string
  label: string
  total: string
  lines: Array<{ description: string; quantity: string; amount: string }>
  validUntil: string
  url: string
  notes?: string
}

export const quoteSent = (q: QuoteMail) =>
  render(
    doc(
      q,
      // The amount in the subject on purpose: it is the fact the customer
      // wants, and hiding it behind a click only makes them open the mail to
      // learn something we could have told them.
      `Your quote from ${q.brand.name} - ${q.total}`,
      `Good until ${q.validUntil}. Nothing to pay today.`,
      `Your quote for ${q.total}`,
      [
        { t: 'lede', text: `${q.customerName ? `${q.customerName}, here` : 'Here'} is the price for the work we talked about.` },
        {
          t: 'rows',
          rows: q.lines.map((l) => [`${l.description} (${l.quantity})`, l.amount] as [string, string]),
        },
        { t: 'total', label: 'Total', value: q.total },
        ...(q.notes ? [{ t: 'para' as const, text: q.notes }] : []),
        { t: 'button', label: 'See it and say yes', href: q.url },
        { t: 'note', text: `This price is good until ${q.validUntil}. You are not paying anything today.` },
      ],
    ),
    q,
    'quote',
  )

// ── Invoice ──────────────────────────────────────────────────────────────

export interface InvoiceMail extends Common {
  customerName?: string
  label: string
  total: string
  due: string
  url: string
  /** Bank details or similar, when card payment is not switched on. */
  howToPay?: string
  payable: boolean
}

export const invoiceSent = (i: InvoiceMail) =>
  render(
    doc(
      i,
      `Invoice from ${i.brand.name} - ${i.total}`,
      `Due ${i.due}.`,
      `Invoice ${i.label}`,
      [
        { t: 'lede', text: `${i.customerName ? `${i.customerName}, thanks` : 'Thanks'} for the work. Here is the invoice.` },
        { t: 'total', label: 'Amount due', value: i.total },
        { t: 'rows', rows: [['Due', i.due]] },
        {
          t: 'button',
          // Says what the button does. "View invoice" makes someone who wants
          // to pay wonder whether they are in the right place.
          label: i.payable ? `Pay ${i.total} now` : 'Open the invoice',
          href: i.url,
        },
        ...(i.howToPay
          ? [
              { t: 'rule' as const },
              { t: 'para' as const, text: 'How to pay' },
              { t: 'para' as const, text: i.howToPay },
              // The reference is the difference between a payment that gets
              // matched and one that becomes a phone call.
              { t: 'note' as const, text: `Please use ${i.label} as the reference so we know it is from you.` },
            ]
          : []),
        {
          t: 'note',
          text: 'Already paid? We will mark it off once it arrives. Bank transfers can take a day.',
        },
      ],
    ),
    i,
    'invoice',
  )

// ── Booking ──────────────────────────────────────────────────────────────

export interface BookingMail extends Common {
  customerName?: string
  service: string
  when: string
  /** Present only when a deposit was taken. */
  deposit?: string
  cancelUrl: string
}

export const bookingConfirmed = (b: BookingMail) =>
  render(
    doc(
      b,
      `Booked: ${b.service}, ${b.when}`,
      `We will see you then.`,
      'You are booked in',
      [
        { t: 'lede', text: `${b.customerName ? `${b.customerName}, that` : 'That'} is confirmed.` },
        {
          t: 'rows',
          rows: [
            ['What', b.service],
            ['When', b.when],
            ...(b.deposit ? ([['Deposit paid', b.deposit]] as Array<[string, string]>) : []),
          ],
        },
        { t: 'para', text: 'If something changes, let us know as early as you can.' },
        { t: 'link', label: 'Change or cancel this booking', href: b.cancelUrl },
      ],
    ),
    b,
    'booking',
  )

export const bookingReminder = (b: BookingMail) =>
  render(
    doc(
      b,
      `Reminder: ${b.service}, ${b.when}`,
      'A quick reminder about tomorrow.',
      'Coming up',
      [
        { t: 'lede', text: `A reminder that we are booked in for ${b.when}.` },
        { t: 'rows', rows: [['What', b.service], ['When', b.when]] },
        { t: 'link', label: 'Change or cancel this booking', href: b.cancelUrl },
      ],
    ),
    b,
    'reminder',
  )

export const bookingCancelled = (b: Common & { customerName?: string; service: string; when: string }) =>
  render(
    doc(
      b,
      `Cancelled: ${b.service}, ${b.when}`,
      'Your booking has been cancelled.',
      'That booking is cancelled',
      [
        { t: 'lede', text: `${b.customerName ? `${b.customerName}, your` : 'Your'} ${b.service} on ${b.when} has been cancelled.` },
        // Never leave a cancellation without a way back: the customer still
        // wants the work done, and this is the moment they might go elsewhere.
        { t: 'para', text: 'If you would still like the work done, get in touch and we will find another time.' },
      ],
    ),
    b,
    'cancelled',
  )

// ── Review ask: the only optional one ────────────────────────────────────

export interface ReviewMail extends Common {
  customerName?: string
  message: string
  url: string
  unsubscribeUrl: string
}

export const reviewAsk = (r: ReviewMail) =>
  render(
    doc(
      r,
      `How did we do?`,
      'It takes a minute, and it helps a lot.',
      'How did we do?',
      [
        { t: 'lede', text: r.customerName ? `${r.customerName}, thanks for having us.` : 'Thanks for having us.' },
        { t: 'para', text: r.message },
        { t: 'button', label: 'Leave a review', href: r.url },
        // Says it once and means it. The promise is what stops the next one
        // being reported as spam.
        { t: 'note', text: 'We will only ask once.' },
      ],
      { url: r.unsubscribeUrl, mailto: '' },
    ),
    r,
    'review',
  )

// ── Reply to an enquiry ──────────────────────────────────────────────────

export const requestReply = (r: Common & { subject: string; body: string }) =>
  render(
    doc(
      r,
      `Re: ${r.subject}`,
      'A reply to your message.',
      r.subject,
      [
        { t: 'para', text: r.body },
        // Reply-To is set to the owner's real address, so this is true.
        { t: 'note', text: 'You can reply straight to this email and it will reach us.' },
      ],
    ),
    r,
    'reply',
  )
