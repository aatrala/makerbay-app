import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { bookingReminder } from '@makerbay/email'
import { ddb, emitUsage, getTenant, getTenantBrand, sendEmail } from '@makerbay/core'
import { displayTime } from './slots'

/**
 * Fired by an EventBridge one-off schedule created when the booking was made.
 * The schedule cannot be trusted alone - the booking may have been cancelled
 * since - so the row's current status decides whether anything sends.
 */
export const handler = async (event: { tenantId: string; bookingId: string }): Promise<void> => {
  const r = await ddb.send(
    new GetCommand({
      TableName: process.env.TABLE_BOOKINGS!,
      Key: { tenantId: event.tenantId, bookingId: event.bookingId },
    }),
  )
  const booking = r.Item
  if (!booking || booking.status !== 'confirmed' || !booking.email) return
  // The appointment may have been moved earlier; never remind after the fact.
  if (new Date(String(booking.startsAt)).getTime() < Date.now()) return

  const cfg = await ddb.send(
    new GetCommand({ TableName: process.env.TABLE_BOOKINGCONFIG!, Key: { tenantId: event.tenantId } }),
  )
  const timezone = String(cfg.Item?.timezone ?? 'UTC')
  // Independent reads, together - these ran in series per reminder.
  const [tenant, brand] = await Promise.all([
    getTenant(event.tenantId),
    getTenantBrand(event.tenantId),
  ])
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(String(booking.startsAt)))
  const mail = bookingReminder({
    brand,
    contact: { email: String(cfg.Item?.notifyEmail ?? '') || undefined },
    customerName: booking.name ? String(booking.name) : undefined,
    service: String(booking.serviceName),
    when: `${when} at ${displayTime(String(booking.startsAt), timezone)}`,
    cancelUrl: `https://chat.makerbay.app/booking/cancel?slug=${encodeURIComponent(tenant?.slug ?? '')}&token=${booking.cancelToken}`,
  })
  const notice = await sendEmail({
    to: String(booking.email),
    ref: {
      tenantId: event.tenantId,
      moduleId: 'booking',
      refType: 'booking',
      refId: String(booking.bookingId),
    },
    audience: 'customer' as const,
    // Outside the daily cap (issue 134): this fires on a schedule, long after
    // the booking it belongs to, and a reminder for a confirmed appointment
    // must not be lost because the day's allowance went on something else.
    exempt: true,
    fromName: brand.name,
    replyTo: String(cfg.Item?.notifyEmail ?? ''),
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  })
  if (notice.sent) {
    await emitUsage({ tenantId: event.tenantId, moduleId: 'booking', metric: 'reminder.sent', quantity: 1 })
  }
}
