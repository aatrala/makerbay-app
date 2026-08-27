import { describe, expect, it } from 'vitest'
import { KINDS, type CurrentState } from './kinds'
import { EMPTY, type ExtractedFacts } from './extract'

const facts = (over: Partial<ExtractedFacts> = {}): ExtractedFacts => ({ ...EMPTY, ...over })
const state = (over: Partial<CurrentState> = {}): CurrentState =>
  ({ presence: {}, services: [], ...over })

describe('presence.page', () => {
  const stage = KINDS['presence.page'].stage

  it('fills a field the page has not got', () => {
    const r = stage(facts({ headline: 'Blocked drains, Newtown' }), state())
    expect(r.proposed.headline).toBe('Blocked drains, Newtown')
    expect(r.diff).toHaveLength(1)
  })

  it('never overwrites what the owner wrote', () => {
    const r = stage(
      facts({ headline: 'From the website', intro: 'Also from the website' }),
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
      facts({ services: [{ name: 'Blocked drain callout', priceCents: 18000, durationMinutes: 90 }] }),
      state(),
    )
    expect((r.proposed.services as unknown[])).toHaveLength(1)
    expect(r.diff[0].label).toBe('Blocked drain callout')
    expect(r.diff[0].to).toBe('$180.00, 90 min')
  })

  // The owner typed theirs and the website wrote ours; neither knows about
  // the other, so matching is on the name a human would compare.
  it('skips one the owner already has, whatever the case or spacing', () => {
    const r = stage(
      facts({ services: [{ name: '  BLOCKED Drain Callout ' }, { name: 'Hot water' }] }),
      state({ services: [{ serviceId: 'S1', name: 'Blocked drain callout' }] }),
    )
    expect(r.diff.map((d) => d.label)).toEqual(['Hot water'])
  })

  it('says so plainly when a scraped service has no price', () => {
    const r = stage(facts({ services: [{ name: 'Emergency callout' }] }), state())
    expect(r.diff[0].to).toBe('no price')
  })

  it('proposes nothing when the list is already complete', () => {
    const r = stage(
      facts({ services: [{ name: 'Hot water' }] }),
      state({ services: [{ serviceId: 'S1', name: 'Hot water' }] }),
    )
    expect(r.diff).toHaveLength(0)
    expect(r.proposed.services).toEqual([])
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

  it('stages nothing from empty facts, so a failed read never proposes a change', () => {
    for (const [id, def] of Object.entries(KINDS)) {
      expect(def.stage(EMPTY, state()).diff, id).toHaveLength(0)
    }
  })
})
