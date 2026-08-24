import { describe, expect, it } from 'vitest'
import { openDates, slotStillFree, slotsFor, weekdayOf, zoned, type BookingHours } from './slots'

const SYD = 'Australia/Sydney'

const config = (over: Partial<BookingHours> = {}): BookingHours => ({
  timezone: SYD,
  hours: { mon: [{ from: '09:00', to: '12:00' }] },
  leadTimeHours: 0,
  horizonDays: 60,
  closures: [],
  ...over,
})

const service = { durationMinutes: 60, bufferMinutes: 0 }

// 2026-08-24 is a Monday. Sydney is UTC+10 in August (standard time).
const MONDAY = '2026-08-24'
const before = new Date('2026-08-01T00:00:00Z')

describe('zoned', () => {
  it('maps a wall-clock time in the business zone to the right instant', () => {
    // 09:00 Sydney in August (UTC+10) is 23:00 UTC the previous day.
    expect(zoned(MONDAY, '09:00', SYD).toISOString()).toBe('2026-08-23T23:00:00.000Z')
  })

  it('handles a zone behind UTC', () => {
    // 09:00 New York in August (UTC-4) is 13:00 UTC the same day.
    expect(zoned(MONDAY, '09:00', 'America/New_York').toISOString()).toBe('2026-08-24T13:00:00.000Z')
  })

  it('is stable across a DST boundary', () => {
    // Sydney moves to UTC+11 in October. 09:00 local must stay 09:00 local.
    const summer = zoned('2026-12-07', '09:00', SYD)
    const shown = new Intl.DateTimeFormat('en-GB', {
      timeZone: SYD, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(summer)
    expect(shown).toBe('09:00')
  })

  it('agrees with the zone for UTC itself', () => {
    expect(zoned(MONDAY, '09:00', 'UTC').toISOString()).toBe('2026-08-24T09:00:00.000Z')
  })
})

describe('weekdayOf', () => {
  it('reads the weekday in the business zone, not UTC', () => {
    expect(weekdayOf(MONDAY, SYD)).toBe('mon')
    expect(weekdayOf('2026-08-29', SYD)).toBe('sat')
  })
})

describe('slotsFor', () => {
  it('fills the opening window with whole appointments', () => {
    const slots = slotsFor(config(), service, [], MONDAY, before)
    expect(slots.map((s) => s.label)).toEqual(['09:00', '10:00', '11:00'])
  })

  it('never offers a slot that runs past closing', () => {
    const slots = slotsFor(config(), { durationMinutes: 90, bufferMinutes: 0 }, [], MONDAY, before)
    // 09:00 and 10:30 fit in a three-hour window; 12:00 would overrun.
    expect(slots.map((s) => s.label)).toEqual(['09:00', '10:30'])
  })

  it('returns nothing on a day with no opening hours', () => {
    expect(slotsFor(config(), service, [], '2026-08-25', before)).toEqual([])
  })

  it('returns nothing on a closure day', () => {
    const c = config({ closures: [{ date: MONDAY, reason: 'Public holiday' }] })
    expect(slotsFor(c, service, [], MONDAY, before)).toEqual([])
  })

  it('removes a slot taken by an existing booking', () => {
    const busy = [{ startsAt: '2026-08-24T00:00:00.000Z', endsAt: '2026-08-24T01:00:00.000Z' }]
    const slots = slotsFor(config(), service, busy, MONDAY, before)
    // That is 10:00-11:00 Sydney.
    expect(slots.map((s) => s.label)).toEqual(['09:00', '11:00'])
  })

  it('blocks the buffer on both sides of a booking', () => {
    const busy = [{ startsAt: '2026-08-24T00:00:00.000Z', endsAt: '2026-08-24T01:00:00.000Z' }]
    const slots = slotsFor(config(), { durationMinutes: 60, bufferMinutes: 30 }, busy, MONDAY, before)
    // A 30-minute buffer either side of 10:00-11:00 removes 09:00 and 11:00 too.
    expect(slots).toEqual([])
  })

  it('ignores a cancelled booking, because callers filter before passing busy', () => {
    // blocking() is the filter; slotsFor trusts what it is given.
    expect(slotsFor(config(), service, [], MONDAY, before)).toHaveLength(3)
  })

  it('respects lead time measured from now', () => {
    const now = new Date('2026-08-23T23:30:00Z') // 09:30 Sydney on the day
    const slots = slotsFor(config({ leadTimeHours: 2 }), service, [], MONDAY, now)
    // Earliest permitted start is 11:30 Sydney, so only nothing fits before noon.
    expect(slots).toEqual([])
  })

  it('handles two opening windows in one day', () => {
    const c = config({ hours: { mon: [{ from: '09:00', to: '11:00' }, { from: '14:00', to: '16:00' }] } })
    const slots = slotsFor(c, service, [], MONDAY, before)
    expect(slots.map((s) => s.label)).toEqual(['09:00', '10:00', '14:00', '15:00'])
  })
})

describe('slotStillFree', () => {
  const busy = [{ startsAt: '2026-08-24T00:00:00.000Z', endsAt: '2026-08-24T01:00:00.000Z' }]

  it('accepts a slot that does not overlap', () => {
    expect(slotStillFree(service, busy, '2026-08-24T01:00:00.000Z', '2026-08-24T02:00:00.000Z')).toBe(true)
  })

  it('rejects an exact double booking', () => {
    expect(slotStillFree(service, busy, '2026-08-24T00:00:00.000Z', '2026-08-24T01:00:00.000Z')).toBe(false)
  })

  it('rejects a partial overlap', () => {
    expect(slotStillFree(service, busy, '2026-08-24T00:30:00.000Z', '2026-08-24T01:30:00.000Z')).toBe(false)
  })

  it('rejects a booking that swallows an existing one', () => {
    expect(slotStillFree(service, busy, '2026-08-23T23:00:00.000Z', '2026-08-24T03:00:00.000Z')).toBe(false)
  })

  it('rejects a slot inside the buffer', () => {
    const buffered = { durationMinutes: 60, bufferMinutes: 30 }
    expect(slotStillFree(buffered, busy, '2026-08-24T01:00:00.000Z', '2026-08-24T02:00:00.000Z')).toBe(false)
  })

  it('refuses a zero-length or reversed range', () => {
    expect(slotStillFree(service, [], '2026-08-24T05:00:00.000Z', '2026-08-24T05:00:00.000Z')).toBe(false)
    expect(slotStillFree(service, [], '2026-08-24T06:00:00.000Z', '2026-08-24T05:00:00.000Z')).toBe(false)
  })

  it('refuses an unparseable time rather than treating it as free', () => {
    expect(slotStillFree(service, [], 'not-a-date', '2026-08-24T05:00:00.000Z')).toBe(false)
  })
})

describe('openDates', () => {
  it('offers only days the business actually works', () => {
    const dates = openDates(config(), new Date('2026-08-24T00:00:00Z'), 3)
    // Mondays only.
    expect(dates).toEqual(['2026-08-24', '2026-08-31', '2026-09-07'])
  })

  it('skips closures', () => {
    const c = config({ closures: [{ date: '2026-08-31' }] })
    const dates = openDates(c, new Date('2026-08-24T00:00:00Z'), 2)
    expect(dates).toEqual(['2026-08-24', '2026-09-07'])
  })

  it('stops at the horizon', () => {
    const dates = openDates(config({ horizonDays: 3 }), new Date('2026-08-24T00:00:00Z'), 10)
    expect(dates).toEqual(['2026-08-24'])
  })
})
