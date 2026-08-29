/**
 * Placeholder text that sounds like the reader's own trade (issue 143).
 *
 * Onboarding has asked "what do you do?" since issue 83 and stored the answer,
 * and nothing has ever read it. So a hairdresser filling in her first service
 * saw "Standard service call" priced at $45, and her first quote line
 * suggested "Labour, qualified electrician". A plumber, on the other side of
 * the same defaults, got salon money.
 *
 * Placeholders are not decoration. They are the fastest signal a new user gets
 * about whether a product was built for them, and they are read at exactly the
 * moment somebody is deciding whether to keep going.
 *
 * Free text, not an enum: the trade is stored as a free-form string capped at
 * 40 characters, and matching is loose on purpose so "Plumbing & gas" and
 * "plumber" both land somewhere sensible. Anything unrecognised gets the
 * neutral set, which is deliberately trade-free rather than quietly Australian
 * or quietly a salon.
 */

export interface TradeExamples {
  /** A service on the booking page. */
  service: string
  servicePrice: string
  deposit: string
  /** A line on a quote. */
  quoteLine: string
  /** The compliance footer on documents. */
  docFooter: string
}

const NEUTRAL: TradeExamples = {
  service: 'Standard visit',
  servicePrice: '90.00',
  deposit: '25.00',
  quoteLine: 'Labour',
  docFooter: 'Business number · Licence number',
}

/**
 * Keyed on a lowercase fragment, matched by substring, first hit wins. Order
 * matters where one trade's word appears inside another's.
 */
const BY_KEYWORD: Array<[string, TradeExamples]> = [
  ['plumb', {
    service: 'Blocked drain',
    servicePrice: '180.00',
    deposit: '50.00',
    quoteLine: 'Labour, licensed plumber',
    docFooter: 'Business number · Plumbing licence',
  }],
  ['electric', {
    service: 'Switchboard inspection',
    servicePrice: '160.00',
    deposit: '50.00',
    quoteLine: 'Labour, licensed electrician',
    docFooter: 'Business number · Electrical licence',
  }],
  ['hvac', {
    service: 'Air conditioning service',
    servicePrice: '190.00',
    deposit: '50.00',
    quoteLine: 'Labour, refrigeration technician',
    docFooter: 'Business number · Refrigerant handling licence',
  }],
  ['refrigerat', {
    service: 'Air conditioning service',
    servicePrice: '190.00',
    deposit: '50.00',
    quoteLine: 'Labour, refrigeration technician',
    docFooter: 'Business number · Refrigerant handling licence',
  }],
  ['clean', {
    service: 'End of lease clean',
    servicePrice: '320.00',
    deposit: '80.00',
    quoteLine: 'Cleaning, two staff',
    docFooter: 'Business number · Public liability insurer',
  }],
  ['landscap', {
    service: 'Garden tidy up',
    servicePrice: '220.00',
    deposit: '60.00',
    quoteLine: 'Labour and green waste removal',
    docFooter: 'Business number · Public liability insurer',
  }],
  ['garden', {
    service: 'Garden tidy up',
    servicePrice: '220.00',
    deposit: '60.00',
    quoteLine: 'Labour and green waste removal',
    docFooter: 'Business number · Public liability insurer',
  }],
  ['carpent', {
    service: 'Site visit and measure',
    servicePrice: '150.00',
    deposit: '200.00',
    quoteLine: 'Labour, qualified carpenter',
    docFooter: 'Business number · Builder licence',
  }],
  ['build', {
    service: 'Site visit and measure',
    servicePrice: '150.00',
    deposit: '200.00',
    quoteLine: 'Labour, qualified carpenter',
    docFooter: 'Business number · Builder licence',
  }],
  ['handy', {
    service: 'Half day of odd jobs',
    servicePrice: '240.00',
    deposit: '60.00',
    quoteLine: 'Labour, half day',
    docFooter: 'Business number · Public liability insurer',
  }],
  ['paint', {
    service: 'Quote visit',
    servicePrice: '0.00',
    deposit: '150.00',
    quoteLine: 'Preparation and two coats',
    docFooter: 'Business number · Painter licence',
  }],
  ['salon', {
    service: 'Cut and blow dry',
    servicePrice: '65.00',
    deposit: '20.00',
    quoteLine: 'Colour, full head',
    docFooter: 'Business number',
  }],
  ['beauty', {
    service: 'Facial, 60 minutes',
    servicePrice: '95.00',
    deposit: '25.00',
    quoteLine: 'Treatment course, six sessions',
    docFooter: 'Business number',
  }],
  ['hair', {
    service: 'Cut and blow dry',
    servicePrice: '65.00',
    deposit: '20.00',
    quoteLine: 'Colour, full head',
    docFooter: 'Business number',
  }],
  ['tutor', {
    service: 'One hour lesson',
    servicePrice: '60.00',
    deposit: '0.00',
    quoteLine: 'Ten lesson block',
    docFooter: 'Business number · Working with children check',
  }],
  ['coach', {
    service: 'One hour session',
    servicePrice: '80.00',
    deposit: '0.00',
    quoteLine: 'Six session programme',
    docFooter: 'Business number · Working with children check',
  }],
  ['pet', {
    service: 'Dog groom, medium',
    servicePrice: '75.00',
    deposit: '20.00',
    quoteLine: 'Grooming, medium coat',
    docFooter: 'Business number · Public liability insurer',
  }],
]

export function tradeExamples(trade?: string): TradeExamples {
  const t = (trade ?? '').toLowerCase()
  if (!t) return NEUTRAL
  for (const [key, examples] of BY_KEYWORD) {
    if (t.includes(key)) return examples
  }
  return NEUTRAL
}
