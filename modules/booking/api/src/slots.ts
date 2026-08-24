/**
 * Slot computation. Deliberately pure: no AWS, no clock of its own, no I/O.
 * Everything that decides whether an appointment can exist lives here so it
 * can be tested directly.
 *
 * Storage is always UTC. Display and opening hours are always the business
 * timezone. Mixing those is how booking systems produce appointments an hour
 * out twice a year, so the conversion happens in exactly one place: `zoned`.
 */

export interface OpeningWindow {
  from: string // 'HH:MM' in the business timezone
  to: string
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export interface BookingHours {
  timezone: string
  hours: Partial<Record<Weekday, OpeningWindow[]>>
  leadTimeHours: number
  horizonDays: number
  closures: Array<{ date: string; reason?: string }>
}

export interface BookableService {
  durationMinutes: number
  bufferMinutes: number
}

export interface BusySlot {
  startsAt: string // ISO instant
  endsAt: string
}

/**
 * The UTC instant for a wall-clock time on a given date in a given timezone.
 *
 * Intl is the only timezone database available in a Lambda without shipping
 * one, so this asks it what a candidate instant looks like in the target zone
 * and corrects by the difference. Two passes settle DST transitions, where the
 * first correction can land on the other side of the change.
 */
export function zoned(dateISO: string, hhmm: string, timezone: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  const [y, mo, d] = dateISO.split('-').map(Number)
  let guess = Date.UTC(y, mo - 1, d, h, m, 0, 0)

  for (let i = 0; i < 2; i++) {
    const offset = zoneOffsetMs(new Date(guess), timezone)
    const corrected = Date.UTC(y, mo - 1, d, h, m, 0, 0) - offset
    if (corrected === guess) break
    guess = corrected
  }
  return new Date(guess)
}

/** How far ahead of UTC the zone is at that instant, in milliseconds. */
function zoneOffsetMs(at: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]))
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Intl renders midnight as hour 24 in some environments.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  return asUtc - at.getTime()
}

/** The weekday key for a date, as seen in the business timezone. */
export function weekdayOf(dateISO: string, timezone: string): Weekday {
  const noon = zoned(dateISO, '12:00', timezone)
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' })
    .format(noon)
    .toLowerCase()
  return (WEEKDAYS.find((d) => name.startsWith(d)) ?? 'mon') as Weekday
}

/** 'HH:MM' as displayed in the business timezone. */
export function displayTime(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(instant))
}

export interface Slot {
  startsAt: string
  endsAt: string
  label: string
}

/**
 * Free slots for one service on one date.
 *
 * `now` is passed in rather than read, so tests are not time-dependent and a
 * caller can ask "what was free yesterday" without lying about the clock.
 */
export function slotsFor(
  config: BookingHours,
  service: BookableService,
  busy: BusySlot[],
  dateISO: string,
  now: Date,
): Slot[] {
  if (config.closures?.some((c) => c.date === dateISO)) return []

  const windows = config.hours[weekdayOf(dateISO, config.timezone)] ?? []
  if (windows.length === 0) return []

  const duration = Math.max(5, service.durationMinutes) * 60_000
  const buffer = Math.max(0, service.bufferMinutes) * 60_000
  const earliest = now.getTime() + Math.max(0, config.leadTimeHours) * 3_600_000

  // A booking blocks its own time plus the buffer on each side, so the next
  // customer is not booked into travel or clean-down time.
  const blocked = busy.map((b) => ({
    from: new Date(b.startsAt).getTime() - buffer,
    to: new Date(b.endsAt).getTime() + buffer,
  }))

  const out: Slot[] = []
  for (const w of windows) {
    const open = zoned(dateISO, w.from, config.timezone).getTime()
    const close = zoned(dateISO, w.to, config.timezone).getTime()

    for (let start = open; start + duration <= close; start += duration) {
      const end = start + duration
      if (start < earliest) continue
      if (blocked.some((b) => start < b.to && end > b.from)) continue
      const startsAt = new Date(start).toISOString()
      out.push({
        startsAt,
        endsAt: new Date(end).toISOString(),
        label: displayTime(startsAt, config.timezone),
      })
    }
  }
  return out
}

/**
 * Does this exact booking still fit? Checked again at write time, because two
 * customers can load the same slot list a second apart and the loser must be
 * told rather than silently overwriting the winner.
 */
export function slotStillFree(
  service: BookableService,
  busy: BusySlot[],
  startsAt: string,
  endsAt: string,
): boolean {
  const buffer = Math.max(0, service.bufferMinutes) * 60_000
  const from = new Date(startsAt).getTime()
  const to = new Date(endsAt).getTime()
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return false
  return !busy.some((b) => {
    const bFrom = new Date(b.startsAt).getTime() - buffer
    const bTo = new Date(b.endsAt).getTime() + buffer
    return from < bTo && to > bFrom
  })
}

/** Dates worth offering: today through the horizon, skipping closed days. */
export function openDates(config: BookingHours, now: Date, limit = 14): string[] {
  const out: string[] = []
  const closed = new Set((config.closures ?? []).map((c) => c.date))
  for (let i = 0; i < config.horizonDays && out.length < limit; i++) {
    const day = new Date(now.getTime() + i * 86_400_000)
    const dateISO = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(day)
    if (closed.has(dateISO)) continue
    if ((config.hours[weekdayOf(dateISO, config.timezone)] ?? []).length === 0) continue
    out.push(dateISO)
  }
  return out
}
