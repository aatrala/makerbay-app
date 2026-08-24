import { describe, expect, it } from 'vitest'
import { remindAt } from './reminder-time'

const now = new Date('2026-08-24T00:00:00Z')

describe('remindAt', () => {
  it('gives a full day of notice when there is room', () => {
    expect(remindAt('2026-08-27T00:00:00Z', now)?.toISOString()).toBe('2026-08-26T00:00:00.000Z')
  })

  it('falls back to two hours for near bookings', () => {
    expect(remindAt('2026-08-24T10:00:00Z', now)?.toISOString()).toBe('2026-08-24T08:00:00.000Z')
  })

  it('sends nothing when the booking is too soon - late reminders are worse than none', () => {
    expect(remindAt('2026-08-24T02:00:00Z', now)).toBeNull()
  })

  it('the 26-hour boundary avoids a reminder landing minutes after booking', () => {
    // 25h out: a day-before reminder would fire in 1h - fine as the 2h rule.
    expect(remindAt('2026-08-25T01:00:00Z', now)?.toISOString()).toBe('2026-08-24T23:00:00.000Z')
  })

  it('refuses garbage input', () => {
    expect(remindAt('not-a-date', now)).toBeNull()
  })
})
