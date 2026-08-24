/**
 * When to remind about a booking. Pure, so the rules are testable:
 * far-out bookings get a day's notice, near ones a couple of hours,
 * and anything sooner than that gets none - a reminder arriving after
 * the appointment is worse than silence.
 */
export function remindAt(startsAt: string, now: Date): Date | null {
  const start = new Date(startsAt).getTime()
  if (!Number.isFinite(start)) return null
  const lead = start - now.getTime()
  if (lead > 26 * 3_600_000) return new Date(start - 24 * 3_600_000)
  if (lead > 3 * 3_600_000) return new Date(start - 2 * 3_600_000)
  return null
}
