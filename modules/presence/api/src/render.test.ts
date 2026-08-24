import { describe, expect, it } from 'vitest'
import type { PresenceConfigRow, ServiceView } from './db'
import { indexDirective, isComplete, localBusinessJsonLd, openState, renderPage } from './render'

const config = (over: Partial<PresenceConfigRow> = {}): PresenceConfigRow => ({
  tenantId: 't',
  headline: 'Emergency electrician, Coimbatore',
  intro: 'Twenty years of residential electrical work across Coimbatore. Licensed, insured, and honest about what a job costs before it starts.',
  serviceAreas: ['Kalapatti', 'Saravanampatti'],
  phone: '+91 98406 75289',
  email: 'joe@example.com',
  photoKey: 'p/t/hero.jpg',
  showBooking: true,
  showAssistant: true,
  published: true,
  ...over,
})

const services = (over: Partial<ServiceView>[] = [{}]): ServiceView[] =>
  over.map((s) => ({ name: 'Callout', durationMinutes: 60, priceCents: 9500, ...s }))

const input = (c = config(), s = services()) => ({
  config: c,
  businessName: "Joe's Electrical",
  slug: 'joes-electrical',
  services: s,
  hours: { timezone: 'Australia/Sydney', hours: { mon: [{ from: '09:00', to: '17:00' }] } },
  assistant: { name: 'Assistant', greeting: 'Hi', brandColor: '#c2410c' },
  hasKnowledge: true,
  bookingEnabled: true,
  now: new Date('2026-08-24T00:00:00Z'), // 10:00 Monday in Sydney
})

describe('indexing rules', () => {
  it('a complete page indexes', () => {
    expect(isComplete(input())).toBe(true)
    expect(indexDirective(input())).toBe('index')
  })

  it('no photo means noindex - a bare page per signup is the corpus Google discounts', () => {
    expect(indexDirective(input(config({ photoKey: undefined })))).toBe('noindex')
  })

  it('a thin intro means noindex', () => {
    expect(indexDirective(input(config({ intro: 'We do electrical.' })))).toBe('noindex')
  })

  it('no priced service means noindex', () => {
    expect(indexDirective(input(config(), services([{ priceCents: undefined }])))).toBe('noindex')
    expect(indexDirective(input(config(), services([{ priceCents: 0 }])))).toBe('noindex')
  })

  it('the tradie having their own website forces noindex even when complete', () => {
    // We never compete with our own customer for their brand query.
    expect(indexDirective(input(config({ websiteUrl: 'https://joes.example.com' })))).toBe('noindex')
  })

  it('the directive lands in the rendered HTML', () => {
    expect(renderPage(input())).not.toContain('noindex')
    expect(renderPage(input(config({ photoKey: undefined })))).toContain('noindex, follow')
  })
})

describe('openState', () => {
  const hours = { timezone: 'Australia/Sydney', hours: { mon: [{ from: '09:00', to: '17:00' }] } }

  it('reports open during a window, in the business timezone', () => {
    // 00:00 UTC Monday is 10:00 Sydney Monday.
    const s = openState(hours, new Date('2026-08-24T00:00:00Z'))
    expect(s).toEqual({ open: true, label: 'Open now, until 17:00' })
  })

  it('reports the reopening time after close', () => {
    // 08:00 UTC Monday is 18:00 Sydney - closed, next window is next Monday.
    const s = openState(hours, new Date('2026-08-24T08:00:00Z'))
    expect(s.open).toBe(false)
    expect(s.label).toContain('Monday')
  })

  it('says tomorrow when tomorrow is the next open day', () => {
    const twoDays = { timezone: 'Australia/Sydney', hours: { mon: [{ from: '09:00', to: '17:00' }], tue: [{ from: '09:00', to: '17:00' }] } }
    const s = openState(twoDays, new Date('2026-08-24T08:00:00Z'))
    expect(s.label).toContain('tomorrow')
  })

  it('reports opening time before the day starts', () => {
    // 20:00 UTC Sunday is 06:00 Sydney Monday - before opening.
    const s = openState(hours, new Date('2026-08-23T20:00:00Z'))
    expect(s).toEqual({ open: false, label: 'Closed now, opens at 09:00' })
  })
})

describe('renderPage', () => {
  it('escapes owner-entered content', () => {
    const page = renderPage(input(config({ headline: '<script>alert(1)</script>' })))
    expect(page).not.toContain('<script>alert(1)')
    expect(page).toContain('&lt;script&gt;')
  })

  it('never shows a control that does nothing', () => {
    // Booking off: the book button disappears and the phone becomes the CTA.
    const noBooking = renderPage({ ...input(), bookingEnabled: false })
    expect(noBooking).not.toContain('Book a time')
    expect(noBooking).toContain('Call ')
    // No knowledge: the ask link disappears.
    const noKnowledge = renderPage({ ...input(), hasKnowledge: false })
    expect(noKnowledge).not.toContain('Ask a question')
  })

  it('renders services with prices the customer can add up', () => {
    const page = renderPage(input())
    expect(page).toContain('$95')
    expect(page).toContain('60 min')
  })

  it('carries the canonical URL for the slug', () => {
    expect(renderPage(input())).toContain('https://makerbay.app/p/joes-electrical')
  })
})

describe('localBusinessJsonLd', () => {
  it('is built only from entered data', () => {
    const bare = config({
      phone: '', email: '', serviceAreas: [], intro: '', photoKey: undefined,
    })
    const ld = JSON.parse(localBusinessJsonLd(input(bare, services([{ priceCents: undefined }]))))
    expect(ld.telephone).toBeUndefined()
    expect(ld.areaServed).toBeUndefined()
    expect(ld.makesOffer).toBeUndefined()
    expect(ld.image).toBeUndefined()
    // Name and URL are always real.
    expect(ld.name).toBe("Joe's Electrical")
  })

  it('includes offers only for priced services', () => {
    const ld = JSON.parse(localBusinessJsonLd(input()))
    expect(ld.makesOffer).toHaveLength(1)
    expect(ld.makesOffer[0].price).toBe('95.00')
  })

  it('cannot break out of its script tag', () => {
    const ld = localBusinessJsonLd(input(config({ intro: '</script><script>alert(1)</script> plus forty more characters of intro text' })))
    expect(ld).not.toContain('</script>')
  })
})
