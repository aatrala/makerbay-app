import { describe, expect, it } from 'vitest'
import {
  bookingCancelled, bookingConfirmed, bookingReminder,
  invoiceSent, quoteSent, requestReply, reviewAsk,
} from './customer'
import {
  bookingCancelledByCustomer, depositOnLapsedBooking, depositPaid, missedCall,
  newBooking, newRequest, notificationsBroken, quoteAnswered, requestsDigest,
} from './owner'

/**
 * The rules that hold across every template (issue 94).
 *
 * Written as properties of the whole set rather than assertions about
 * individual wording: the wording is the founder's to change, but "a customer
 * email never says MakerBay in its heading" is a rule that should fail loudly
 * if a future template forgets it.
 */

const brand = { name: 'Dunn Plumbing', accent: '#1d4ed8', footerNote: '' }
const contact = { phone: '0412 345 678', email: 'sam@dunn.example' }
const c = { brand, contact }
const UNSUB = 'https://api.makerbay.app/v1/public/unsubscribe?t=abc123def456ghi789'

const CUSTOMER = [
  ['quote', quoteSent({ ...c, customerName: 'Marie', label: 'Q-014', total: '$368.50',
    validUntil: '26 September 2026', url: 'https://quote.makerbay.app/x/Q-014/tok',
    lines: [{ description: 'Tap', quantity: '2 hours', amount: '$190.00' }] })],
  ['invoice', invoiceSent({ ...c, customerName: 'Marie', label: 'INV-042', total: '$1,240.00',
    due: '12 September 2026', url: 'https://invoice.makerbay.app/x/INV-042/tok', payable: true })],
  ['booking', bookingConfirmed({ ...c, service: 'Blocked drain', when: 'Tuesday 9am',
    cancelUrl: 'https://chat.makerbay.app/booking/cancel?slug=x&token=t' })],
  ['reminder', bookingReminder({ ...c, service: 'Blocked drain', when: 'tomorrow 9am',
    cancelUrl: 'https://chat.makerbay.app/booking/cancel?slug=x&token=t' })],
  ['cancelled', bookingCancelled({ ...c, service: 'Blocked drain', when: 'Tuesday' })],
  ['review', reviewAsk({ ...c, message: 'Thanks!', url: 'https://g.page/x', unsubscribeUrl: UNSUB })],
  ['reply', requestReply({ ...c, subject: 'Leaking tap', body: 'We can come Thursday.' })],
] as const

const OWNER = [
  ['quote accepted', quoteAnswered({ businessName: 'Dunn Plumbing', customerName: 'Marie',
    label: 'Q-014', total: '$368.50', accepted: true, quoteUrl: 'https://app.makerbay.app/quotes/1' })],
  ['quote declined', quoteAnswered({ businessName: 'Dunn Plumbing', customerName: 'Marie',
    label: 'Q-014', total: '$368.50', accepted: false, quoteUrl: 'https://app.makerbay.app/quotes/1' })],
  ['deposit', depositPaid({ businessName: 'Dunn Plumbing', customerName: 'Marie', label: 'Q-014',
    amount: '$92.00', url: 'https://app.makerbay.app/quotes/1' })],
  ['new booking', newBooking({ businessName: 'Dunn Plumbing', who: 'Marie',
    service: 'Blocked drain', when: 'Tuesday 9am' })],
  ['cancelled', bookingCancelledByCustomer({ businessName: 'Dunn Plumbing', who: 'Marie',
    service: 'Blocked drain', when: 'Tuesday' })],
  ['new request', newRequest({ businessName: 'Dunn Plumbing', who: 'Marie', kind: 'enquiry',
    message: 'Dripping tap' })],
  ['missed call', missedCall({ businessName: 'Dunn Plumbing', caller: '0412 345 678',
    texted: true, anonymous: false })],
  ['lapsed deposit', depositOnLapsedBooking({ businessName: 'Dunn Plumbing',
    service: 'Blocked drain', amount: '$50.00' })],
  ['bounce notice', notificationsBroken({ businessName: 'Dunn Plumbing', bounced: 'sam@dunn.example' })],
  ['digest', requestsDigest({ businessName: 'Dunn Plumbing', unsubscribeUrl: UNSUB,
    items: [{ who: 'Marie', summary: 'Dripping tap' }] })],
] as const

const ALL = [...CUSTOMER, ...OWNER]

describe('every template', () => {
  it('renders a subject, an HTML part and a text part', () => {
    for (const [name, m] of ALL) {
      expect(m.subject, name).toBeTruthy()
      expect(m.html, name).toContain('<html')
      expect(m.text.length, name).toBeGreaterThan(20)
    }
  })

  // The text part is not derived from the HTML, so it is the half most likely
  // to be forgotten - and some people genuinely read mail this way.
  it('spells out every link in the text part', () => {
    for (const [name, m] of ALL) {
      for (const href of m.html.match(/href="(https:\/\/[^"]+)"/g) ?? []) {
        const url = href.slice(6, -1).replace(/&amp;/g, '&')
        // The MakerBay footer link is chrome, not content.
        if (url === 'https://makerbay.app') continue
        expect(m.text, `${name} is missing ${url}`).toContain(url)
      }
    }
  })

  it('never leaves an unresolved template hole', () => {
    for (const [name, m] of ALL) {
      expect(m.subject + m.text, name).not.toMatch(/undefined|\[object|NaN/)
    }
  })

  it('keeps subjects short enough to survive a phone inbox', () => {
    for (const [name, m] of ALL) {
      expect(m.subject.length, `${name}: ${m.subject}`).toBeLessThanOrEqual(78)
    }
  })

  it('gives every one a preheader, so the inbox line is not body text', () => {
    for (const [name, m] of ALL) {
      expect(m.html, name).toContain('mso-hide:all')
    }
  })
})

describe('customer mail', () => {
  /**
   * The rule the whole two-identity design exists for. A homeowner has never
   * heard of MakerBay, and a message signed by one company but sent by another
   * is the shape of a phishing email.
   */
  it('never names MakerBay above the footer rule', () => {
    for (const [name, m] of CUSTOMER) {
      // Everything before the rule is what the customer reads as the message.
      const body = m.text.split('---')[0]
      expect(body, name).not.toContain('MakerBay')
      expect(m.subject, name).not.toContain('MakerBay')
    }
  })

  /**
   * The footer DOES name us, and must: we are the sender of record, and an
   * unsolicited-mail regime expects a physical address for whoever actually
   * pressed send. The rule is that it appears there and nowhere else.
   */
  it('names MakerBay in the footer, as the sender of record', () => {
    for (const [name, m] of CUSTOMER) {
      expect(m.text.split('---')[1], name).toContain('MakerBay')
    }
  })

  it('carries the business name instead', () => {
    for (const [name, m] of CUSTOMER) {
      expect(m.text, name).toContain('Dunn Plumbing')
    }
  })

  it('says why the message arrived', () => {
    for (const [name, m] of CUSTOMER) {
      expect(m.text, name).toMatch(/You are getting this because/)
    }
  })

  // An unsubscribe on an invoice invites someone to opt out of the document
  // they are waiting for.
  it('offers an unsubscribe on the review ask and nowhere else', () => {
    for (const [name, m] of CUSTOMER) {
      const has = /Stop getting these emails/.test(m.text)
      expect(has, name).toBe(name === 'review')
    }
  })
})

describe('owner mail', () => {
  it('puts the fact in the subject, so it can be acted on unopened', () => {
    // Each of these should name who or what, not just a category.
    expect(quoteAnswered({ businessName: 'B', customerName: 'Marie', label: 'Q-1',
      total: '$10.00', accepted: true, quoteUrl: 'https://x.example' }).subject).toContain('Marie')
    expect(newBooking({ businessName: 'B', who: 'Marie', service: 'Drain',
      when: 'Tuesday' }).subject).toContain('Drain')
    expect(missedCall({ businessName: 'B', caller: '0412', texted: false,
      anonymous: false }).subject).toContain('0412')
  })

  it('offers an unsubscribe on the digest and nowhere else', () => {
    for (const [name, m] of OWNER) {
      const has = /Stop getting these emails/.test(m.text)
      expect(has, name).toBe(name === 'digest')
    }
  })

  // Money and work arriving is not something anyone opts out of, and the
  // footer used to advertise a preferences page that does not exist.
  it('promises no preferences page', () => {
    for (const [name, m] of OWNER) {
      expect(m.text, name).not.toContain('/settings/notifications')
    }
  })

  it('tells a declined quote what to do about it, not just that it happened', () => {
    const declined = quoteAnswered({ businessName: 'B', customerName: 'Marie', label: 'Q-1',
      total: '$10.00', accepted: false, quoteUrl: 'https://x.example' })
    expect(declined.text.toLowerCase()).toContain('call')
  })
})
