import { describe, expect, it } from 'vitest'
import { initialsOf, KINDS, type CurrentState, type StageInput } from './kinds'
import { EMPTY, type ExtractedFacts } from './extract'

const facts = (over: Partial<ExtractedFacts> = {}): ExtractedFacts => ({ ...EMPTY, ...over })
const state = (over: Partial<CurrentState> = {}): CurrentState =>
  ({ presence: {}, services: [], assistant: {}, sources: [], quotes: {}, booking: {}, ...over })
const input = (over: Partial<StageInput> = {}): StageInput => ({ facts: EMPTY, pages: [], ...over })

describe('presence.page', () => {
  const stage = KINDS['presence.page'].stage

  it('fills a field the page has not got', () => {
    const r = stage(input({ facts: facts({ headline: 'Blocked drains, Newtown' }) }), state())
    expect(r.proposed.headline).toBe('Blocked drains, Newtown')
    expect(r.diff).toHaveLength(1)
  })

  it('never overwrites what the owner wrote', () => {
    const r = stage(
      input({ facts: facts({ headline: 'From the website', intro: 'Also from the website' }) }),
      state({ presence: { headline: 'Mine' } }),
    )
    expect(r.proposed.headline).toBeUndefined()
    expect(r.proposed.intro).toBe('Also from the website')
  })
})

describe('booking.services', () => {
  const stage = KINDS['booking.services'].stage

  it('proposes services the workspace does not have', () => {
    const r = stage(
      input({ facts: facts({ services: [{ name: 'Blocked drain callout', priceCents: 18000, durationMinutes: 90 }] }) }),
      state(),
    )
    expect(r.proposed.services as unknown[]).toHaveLength(1)
    expect(r.diff[0].label).toBe('Blocked drain callout')
    expect(r.diff[0].to).toBe('$180.00, 90 min')
  })

  // The owner typed theirs and the website wrote ours; neither knows about
  // the other, so matching is on the name a human would compare.
  it('skips one the owner already has, whatever the case or spacing', () => {
    const r = stage(
      input({ facts: facts({ services: [{ name: '  BLOCKED Drain Callout ' }, { name: 'Hot water' }] }) }),
      state({ services: [{ serviceId: 'S1', name: 'Blocked drain callout' }] }),
    )
    expect(r.diff.map((d) => d.label)).toEqual(['Hot water'])
  })

  it('says so plainly when a scraped service has no price', () => {
    const r = stage(input({ facts: facts({ services: [{ name: 'Emergency callout' }] }) }), state())
    expect(r.diff[0].to).toBe('no price')
  })
})

describe('assistant.knowledge', () => {
  const stage = KINDS['assistant.knowledge'].stage

  it('proposes pages the assistant has not read', () => {
    const r = stage(input({ pages: ['https://x.com/', 'https://x.com/prices'] }), state())
    expect(r.proposed.pages as string[]).toHaveLength(2)
    expect(r.diff.map((d) => d.label)).toEqual(['Home', '/prices'])
  })

  // The same page reached two ways is still the same page.
  it('skips one already on the list, whatever the trailing slash or fragment', () => {
    const r = stage(
      input({ pages: ['https://x.com/prices/', 'https://x.com/prices#top', 'https://x.com/new'] }),
      state({ sources: [{ sourceId: 'S1', name: 'Prices', url: 'https://x.com/prices' }] }),
    )
    expect(r.proposed.pages as string[]).toEqual(['https://x.com/new'])
  })
})

describe('help.centre', () => {
  const stage = KINDS['help.centre'].stage

  it('switches it on and titles it from the business name', () => {
    const r = stage(input({ facts: facts({ businessName: 'Southside Plumbing' }) }), state())
    expect(r.proposed.helpEnabled).toBe(true)
    expect(r.proposed.helpTitle).toBe('Southside Plumbing help')
  })

  it('leaves a title the owner already chose', () => {
    const r = stage(
      input({ facts: facts({ businessName: 'Southside Plumbing' }) }),
      state({ assistant: { helpTitle: 'Ask us anything' } }),
    )
    expect(r.proposed.helpTitle).toBeUndefined()
  })

  it('does not propose switching on something already on', () => {
    const r = stage(input({ facts: facts({ businessName: 'X' }) }), state({ assistant: { helpEnabled: true } }))
    expect(r.proposed.helpEnabled).toBeUndefined()
  })
})

describe('quotes.documents', () => {
  const stage = KINDS['quotes.documents'].stage

  it('derives a prefix from the business name', () => {
    const r = stage(input({ facts: facts({ businessName: 'Southside Plumbing' }) }), state())
    expect(r.proposed.docPrefix).toBe('SP')
    expect(r.diff[0].to).toContain('SP-Q-001')
  })

  it('leaves a prefix the owner already set', () => {
    const r = stage(
      input({ facts: facts({ businessName: 'Southside Plumbing' }) }),
      state({ quotes: { docPrefix: 'XYZ' } }),
    )
    expect(r.proposed.docPrefix).toBeUndefined()
  })

  it('proposes nothing when the name yields no usable prefix', () => {
    expect(stage(input({ facts: facts({ businessName: 'Bob' }) }), state()).diff).toHaveLength(0)
  })
})

describe('initialsOf', () => {
  it('skips the words nobody would put in a document number', () => {
    expect(initialsOf('Smith and Sons Plumbing')).toBe('SSP')
    expect(initialsOf('The Drain Company')).toBe('DC')
  })
  it('caps at four, so a long name does not produce a silly prefix', () => {
    expect(initialsOf('A B C D E F G')).toHaveLength(4)
  })
})

describe('every kind', () => {
  it('declares the resources and scopes it needs, so a job can be frozen to them', () => {
    for (const [id, def] of Object.entries(KINDS)) {
      expect(def.resources.length, id).toBeGreaterThan(0)
      expect(def.scopes.length, id).toBeGreaterThan(0)
      expect(def.label.length, id).toBeGreaterThan(0)
      expect(def.fields.length, id).toBeGreaterThan(0)
    }
  })

  // A read that found nothing must never turn into a proposal.
  it('stages nothing from an empty read', () => {
    for (const [id, def] of Object.entries(KINDS)) {
      expect(def.stage(input(), state()).diff, id).toHaveLength(0)
    }
  })
})
