import { describe, expect, it, vi } from 'vitest'

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {}, ConverseCommand: class {},
}))

const { validate } = await import('./extract')

/**
 * Opening hours, read off a website (issue 145).
 *
 * The setup flow already extracted services, prices, contact details and the
 * assistant's knowledge, and stopped short of the one thing nearly every trade
 * page states plainly. Without it a new workspace fell back to Monday to
 * Friday, nine to five - wrong for most salons and for anybody working
 * weekends, and wrong in the direction that loses bookings silently.
 *
 * These test the VALIDATOR, not the model. The model proposes; this decides,
 * and a wrong hour is worse than an absent one because an owner would notice
 * an empty field and never notice a plausible lie.
 */

const h = (raw: unknown) => validate({ businessName: 'X', hours: raw }).hours

describe('extracted opening hours', () => {
  it('keeps a well-formed day', () => {
    expect(h({ mon: [{ from: '09:00', to: '17:00' }] })).toEqual({
      mon: [{ from: '09:00', to: '17:00' }],
    })
  })

  it('keeps a lunch break, which is two ranges in a day', () => {
    const r = h({ tue: [{ from: '09:00', to: '12:30' }, { from: '13:30', to: '17:00' }] })
    expect(r?.tue).toHaveLength(2)
  })

  it('reads weekends, rather than assuming a Monday to Friday week', () => {
    const r = h({ sat: [{ from: '08:00', to: '14:00' }], sun: [{ from: '10:00', to: '16:00' }] })
    expect(Object.keys(r ?? {})).toEqual(['sat', 'sun'])
  })

  /**
   * The whole point of Tier C. Anything the model returns in a shape we did
   * not ask for is dropped, never repaired: guessing that "9am" means 09:00
   * is how a customer ends up outside a locked door.
   */
  it('drops anything that is not 24-hour HH:MM', () => {
    for (const bad of ['9am', '9:00', '25:00', '09:60', '', 'morning', '09.00']) {
      expect(h({ mon: [{ from: bad, to: '17:00' }] }), bad).toBeUndefined()
    }
  })

  it('drops a range that ends before it starts', () => {
    expect(h({ mon: [{ from: '17:00', to: '09:00' }] })).toBeUndefined()
    expect(h({ mon: [{ from: '09:00', to: '09:00' }] })).toBeUndefined()
  })

  it('ignores a day that is not a day', () => {
    expect(h({ someday: [{ from: '09:00', to: '17:00' }] })).toBeUndefined()
  })

  it('caps a day at two ranges, because more is the model padding', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      from: `0${i + 1}:00`, to: `0${i + 2}:00`,
    }))
    expect(h({ mon: many })?.mon).toHaveLength(2)
  })

  it('returns nothing at all when the page gave nothing usable', () => {
    expect(h(undefined)).toBeUndefined()
    expect(h({})).toBeUndefined()
    expect(h({ mon: [] })).toBeUndefined()
    expect(h('nine to five')).toBeUndefined()
  })

  // A closed day is simply absent. There is no way to say "closed" that a
  // reader could not confuse with "we did not find out".
  it('keeps only the days the page actually stated', () => {
    const r = h({ mon: [{ from: '09:00', to: '17:00' }], sun: [] })
    expect(Object.keys(r ?? {})).toEqual(['mon'])
  })
})
