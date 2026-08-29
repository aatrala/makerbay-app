import { describe, expect, it } from 'vitest'
import { MAKERBAY_BRAND, type EmailDoc } from './blocks'
import { ownerFooter, customerFooter } from './footers'
import { renderEmail } from './render'

const doc = (over: Partial<EmailDoc> = {}): EmailDoc => ({
  brand: MAKERBAY_BRAND,
  subject: 'Booking confirmed: Thu 3 Sep, 8:30 am',
  preheader: 'Newtown Plumbing, blocked drain callout.',
  heading: 'Booking confirmed',
  blocks: [{ t: 'para', text: 'Your blocked drain callout is booked.' }],
  ...over,
})

const render = (over: Partial<EmailDoc> = {}) =>
  renderEmail(doc(over), ownerFooter('Newtown Plumbing'))

describe('renderEmail', () => {
  // The invariant the whole two-output design exists to guarantee. If a link
  // reaches the HTML and not the text, a plain-text reader cannot get to
  // their quote.
  it('puts every link in the text part as well as the HTML', () => {
    const r = render({
      blocks: [
        { t: 'button', label: 'View quote', href: 'https://makerbay.app/q/1' },
        { t: 'link', label: 'Cancel', href: 'https://makerbay.app/c/2' },
      ],
    })
    for (const href of ['https://makerbay.app/q/1', 'https://makerbay.app/c/2']) {
      expect(r.html).toContain(href)
      expect(r.text).toContain(href)
    }
  })

  it('escapes a business name that contains markup', () => {
    const r = renderEmail(
      doc({ brand: { ...MAKERBAY_BRAND, name: '<script>alert(1)</script>' } }),
      ownerFooter('x'),
    )
    expect(r.html).not.toContain('<script>')
    expect(r.html).toContain('&lt;script&gt;')
  })

  it('escapes content inside every block type', () => {
    const r = render({
      blocks: [
        { t: 'para', text: '<b>x</b>' },
        { t: 'rows', rows: [['<i>k</i>', '<i>v</i>']] },
        { t: 'total', label: '<u>t</u>', value: '<u>1</u>' },
        { t: 'code', value: '<em>123</em>' },
      ],
    })
    for (const tag of ['<b>', '<i>', '<u>', '<em>']) expect(r.html).not.toContain(tag)
  })

  // A javascript: or data: href in an email is an attack, and these hrefs can
  // reach us from a tenant's own configuration.
  it('refuses a href that is not http or https', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd']) {
      const r = render({ blocks: [{ t: 'button', label: 'Go', href: bad }] })
      expect(r.html).not.toContain(bad)
      expect(r.html).toContain('href="#"')
    }
  })

  it('is 600px wide with an MSO ghost table, because Outlook ignores max-width', () => {
    const r = render()
    expect(r.html).toContain('width="600"')
    expect(r.html).toContain('<!--[if mso]>')
  })

  it('gives the button a 44px touch target', () => {
    const r = render({ blocks: [{ t: 'button', label: 'Open', href: 'https://x.com' }] })
    // 13 top + 18 line + 13 bottom.
    expect(r.html).toContain('padding:13px 22px')
    expect(r.html).toContain('line-height:18px')
  })

  it('pairs a brand colour with a foreground that reads on it', () => {
    // #eab308 is the amber that used to ship as white-on-amber at 1.9:1.
    const r = renderEmail(
      doc({
        brand: { ...MAKERBAY_BRAND, accent: '#eab308' },
        blocks: [{ t: 'button', label: 'Open', href: 'https://x.com' }],
      }),
      ownerFooter('x'),
    )
    expect(r.html).toContain('background:#eab308')
    expect(r.html).toContain('color:#1c1917')
  })

  it('carries a dark-mode accent that differs from the light one', () => {
    const r = renderEmail(
      doc({ brand: { ...MAKERBAY_BRAND, accent: '#c2410c' } }),
      ownerFooter('x'),
    )
    // The same orange on a dark card is about 2:1, so the dark rule must not
    // simply repeat it.
    const dark = r.html.match(/\[data-ogsc\] \.mb-a \{ color:(#[0-9a-f]{6})/i)
    expect(dark?.[1].toLowerCase()).not.toBe('#c2410c')
  })

  it('renders the preheader hidden, so it shows in the inbox and not the body', () => {
    const r = render({ preheader: 'Tap to cancel or change.' })
    expect(r.html).toContain('Tap to cancel or change.')
    expect(r.html).toContain('display:none')
  })

  it('never emits a CSS background image, which Gmail strips the whole rule for', () => {
    expect(render().html).not.toContain('url(')
  })

  it('wraps prose at a width a plain-text client expects', () => {
    const long = 'word '.repeat(60).trim()
    const r = render({ blocks: [{ t: 'para', text: long }] })
    // Lines carrying a URL are exempt, deliberately: a wrapped URL is one the
    // reader cannot copy or click, which is worse than a long line.
    const prose = r.text.split('\n').filter((l) => !l.includes('http'))
    for (const line of prose) expect(line.length).toBeLessThanOrEqual(72)
  })

  it('never breaks a URL across lines, however long it is', () => {
    const href = 'https://makerbay.app/quotes/01J8XQ2AAAAAAAAAAAAAAAAAAA/accept?token=' + 'x'.repeat(60)
    const r = render({ blocks: [{ t: 'link', label: 'Accept', href }] })
    expect(r.text).toContain(href)
  })

  it('renders a code large and selectable rather than as an image', () => {
    const r = render({ blocks: [{ t: 'code', value: '482913' }] })
    expect(r.html).toContain('482913')
    expect(r.html).not.toContain('<img')
    expect(r.text).toContain('482913')
  })
})

describe('footers', () => {
  /**
   * The owner footer used to advertise app.makerbay.app/settings/notifications,
   * which does not exist and never has. A 404 promising control over your
   * email is worse than not offering it, so the line is gone and the one
   * owner-bound message anybody would opt out of - the daily digest - carries
   * a real unsubscribe of its own instead (issue 121).
   */
  it('promises no preferences page, because there is not one', () => {
    expect(ownerFooter('X').join(' ')).not.toContain('/settings/notifications')
    expect(ownerFooter('X').join(' ')).not.toMatch(/preferen/i)
  })

  it('still tells an owner why they are getting it', () => {
    expect(ownerFooter('Southside Plumbing').join(' ')).toContain('Southside Plumbing')
  })

  // A homeowner has no MakerBay account and must never be offered one.
  it('gives a customer no preference link, and says why they got it', () => {
    const f = customerFooter('Newtown Plumbing', { phone: '0412 555 908' }, 'You booked with Newtown Plumbing.')
    expect(f.join(' ')).not.toContain('settings/notifications')
    expect(f.join(' ')).toContain('You booked with Newtown Plumbing.')
  })

  /**
   * CASL - the strictest regime of the five markets this ships to - wants
   * three things when you send on someone else's behalf: who sent it, who it
   * was sent for, and how the two are related. "Sent for X by <address>"
   * supplied one and a half of the three (issue 131).
   */
  it('names both parties and the relationship between them', () => {
    const f = customerFooter('Newtown Plumbing', {}, 'r').join(' ')
    expect(f).toContain('on behalf of Newtown Plumbing')  // who it is for
    expect(f).toContain('by MakerBay')                     // who sent it
    expect(f).toMatch(/booking software they use/)         // and why we are here
  })

  it('carries a postal address in both, which is legally load-bearing', () => {
    for (const f of [ownerFooter('X'), customerFooter('X', {}, 'r')]) {
      expect(f.join(' ')).toContain('Freshwater NSW 2096')
      expect(f.join(' ')).toContain('Appa Technologies Pty Ltd')
    }
  })

  /**
   * The placeholder that shipped in every email for a week. It named a
   * company that does not exist, at an address nobody occupies, and it sat
   * directly under the tradesperson's own phone number where it read as
   * theirs. Nothing caught it because the tests asserted the placeholder.
   */
  it('never names the placeholder entity again', () => {
    const all = [...ownerFooter('X'), ...customerFooter('X', {}, 'r')].join(' ')
    expect(all).not.toContain('MakerBay Pty Ltd')
    expect(all).not.toContain('Wilson Street')
  })
})
