import type { Block, EmailDoc } from '../blocks'
import { MAKERBAY_BRAND } from '../blocks'
import { ownerFooter } from '../footers'
import { renderEmail } from '../render'

/**
 * Mail to the TRADESPERSON (issue 94).
 *
 * These wear MakerBay, correctly: the owner signed up with us and knows who we
 * are. That is the opposite of the customer templates, and the reason the
 * layout takes a brand rather than branching on recipient class.
 *
 * They are read on a phone, between jobs, one-handed, often outside. So every
 * one of them puts the fact in the SUBJECT - who, what, how much - and treats
 * the body as somewhere to confirm it rather than somewhere to reveal it. An
 * owner should be able to act on most of these without opening them.
 */

const doc = (
  subject: string,
  preheader: string,
  heading: string,
  blocks: Block[],
): EmailDoc => ({ brand: MAKERBAY_BRAND, subject, preheader, heading, blocks })

const render = (d: EmailDoc, businessName: string) =>
  renderEmail(d, ownerFooter(businessName))

const APP = 'https://app.makerbay.app'

// ── Money in ─────────────────────────────────────────────────────────────

export interface QuoteAnsweredMail {
  businessName: string
  customerName: string
  label: string
  total: string
  accepted: boolean
  quoteUrl: string
  /** Present when the accepted quote asks for a deposit. */
  deposit?: string
}

export const quoteAnswered = (q: QuoteAnsweredMail) =>
  render(
    doc(
      q.accepted
        ? `${q.customerName} said yes to ${q.label} - ${q.total}`
        : `${q.customerName} declined ${q.label}`,
      q.accepted ? 'Time to book them in.' : 'Worth a call while it is fresh.',
      q.accepted ? 'Quote accepted' : 'Quote declined',
      q.accepted
        ? [
            { t: 'lede', text: `${q.customerName} accepted ${q.label} for ${q.total}.` },
            ...(q.deposit
              ? [{ t: 'note' as const, text: `A ${q.deposit} deposit was asked for. You will get another email when it lands.` }]
              : []),
            { t: 'button', label: 'Book them in', href: `${APP}/booking/diary` },
            { t: 'link', label: 'See the quote', href: q.quoteUrl },
          ]
        : [
            { t: 'lede', text: `${q.customerName} declined ${q.label}.` },
            // The useful thing here is not the fact, it is what to do about
            // it - a declined quote is the best time to ring.
            { t: 'para', text: 'A quick call while it is fresh is usually worth more than a new quote.' },
            { t: 'link', label: 'See the quote', href: q.quoteUrl },
          ],
    ),
    q.businessName,
  )

export const depositPaid = (d: {
  businessName: string; customerName: string; label: string; amount: string; url: string
}) =>
  render(
    doc(
      `${d.customerName} paid the ${d.amount} deposit on ${d.label}`,
      'The money is on its way to you.',
      'Deposit paid',
      [
        { t: 'lede', text: `${d.customerName} paid ${d.amount} on ${d.label}.` },
        { t: 'link', label: 'See it', href: d.url },
      ],
    ),
    d.businessName,
  )

// ── Work coming in ───────────────────────────────────────────────────────

export const newBooking = (b: {
  businessName: string; who: string; service: string; when: string; note?: string; deposit?: string
}) =>
  render(
    doc(
      `New booking: ${b.service}, ${b.when}`,
      `${b.who} booked in.`,
      'New booking',
      [
        { t: 'lede', text: `${b.who} booked ${b.service}.` },
        {
          t: 'rows',
          rows: [
            ['When', b.when],
            ...(b.deposit ? ([['Deposit paid', b.deposit]] as Array<[string, string]>) : []),
          ],
        },
        ...(b.note ? [{ t: 'para' as const, text: b.note }] : []),
        { t: 'button', label: 'Open the diary', href: `${APP}/booking/diary` },
      ],
    ),
    b.businessName,
  )

export const bookingCancelledByCustomer = (b: {
  businessName: string; who: string; service: string; when: string
}) =>
  render(
    doc(
      `Cancelled: ${b.service}, ${b.when}`,
      `${b.who} cancelled. That slot is free again.`,
      'A booking was cancelled',
      [
        { t: 'lede', text: `${b.who} cancelled their ${b.service} on ${b.when}.` },
        { t: 'para', text: 'The slot is open again, so somebody else can book it.' },
        { t: 'button', label: 'Open the diary', href: `${APP}/booking/diary` },
      ],
    ),
    b.businessName,
  )

export const newRequest = (r: {
  businessName: string; who: string; kind: string; message: string; contact?: string
}) =>
  render(
    doc(
      `New ${r.kind} from ${r.who}`,
      r.message.slice(0, 90),
      `New ${r.kind}`,
      [
        { t: 'lede', text: `${r.who} left you a message.` },
        { t: 'para', text: r.message },
        ...(r.contact ? [{ t: 'rows' as const, rows: [['Reach them on', r.contact]] as Array<[string, string]> }] : []),
        { t: 'button', label: 'Reply', href: `${APP}/requests` },
      ],
    ),
    r.businessName,
  )

export const missedCall = (m: {
  businessName: string; caller: string; texted: boolean; anonymous: boolean
}) =>
  render(
    doc(
      `Missed call from ${m.anonymous ? 'a withheld number' : m.caller}`,
      m.texted ? 'They have been texted a booking link.' : 'Nobody could answer.',
      'Missed call',
      [
        { t: 'lede', text: `Someone rang and nobody could answer.` },
        {
          t: 'para',
          text: m.anonymous
            ? 'The number was withheld, so there was no way to text them back.'
            : m.texted
              ? `They have been texted a booking link at ${m.caller}.`
              : `They rang from ${m.caller}. No text went out, so a call back is the only way to catch them.`,
        },
        { t: 'button', label: 'See missed calls', href: `${APP}/voice` },
      ],
    ),
    m.businessName,
  )

// ── The daily digest: the only optional owner mail ───────────────────────

export const requestsDigest = (d: {
  businessName: string
  items: Array<{ who: string; summary: string }>
  unsubscribeUrl: string
}): { subject: string; html: string; text: string } => {
  const n = d.items.length
  return renderEmail(
    {
      brand: MAKERBAY_BRAND,
      subject: `${n} new ${n === 1 ? 'message' : 'messages'} for ${d.businessName} yesterday`,
      preheader: 'While you were working.',
      heading: n === 1 ? 'One message yesterday' : `${n} messages yesterday`,
      blocks: [
        {
          t: 'lede',
          text: `While you were working, ${n === 1 ? 'someone' : `${n} people`} got in touch.`,
        },
        { t: 'rows', rows: d.items.map((i) => [i.who, i.summary] as [string, string]) },
        { t: 'button', label: 'Open them', href: `${APP}/requests` },
      ],
      // The one owner-bound email a person can reasonably not want. Everything
      // else here is money or work arriving, which nobody opts out of.
      unsubscribe: { url: d.unsubscribeUrl, mailto: '' },
    },
    ownerFooter(d.businessName),
  )
}

// ── Something is wrong ───────────────────────────────────────────────────

/**
 * The owner's own notification address is bouncing.
 *
 * A silent product failure otherwise: they simply think no work is coming in.
 * Deliberately plain and slightly alarming, because it needs acting on.
 */
export const notificationsBroken = (n: { businessName: string; bounced: string }) =>
  render(
    doc(
      'Your notification email is not working',
      'You are not being told about new work.',
      'We cannot reach you',
      [
        { t: 'lede', text: `Emails to ${n.bounced} are bouncing.` },
        {
          t: 'para',
          text: `That means ${n.businessName} is not being told about new bookings, requests or quotes going out.`,
        },
        {
          t: 'para',
          text: 'Nothing has been lost. Everything is still in your dashboard, and the moment you fix the address the notifications start again.',
        },
        { t: 'button', label: 'Fix the address', href: `${APP}/workspace` },
      ],
    ),
    n.businessName,
  )
