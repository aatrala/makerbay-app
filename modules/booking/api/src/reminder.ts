import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, emitUsage, getTenant, sendEmail } from '@makerbay/core'
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
  const tenant = await getTenant(event.tenantId)
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(String(booking.startsAt)))

  const notice = await sendEmail({
    to: String(booking.email),
    audience: 'customer' as const,
    fromName: tenant?.name ?? 'MakerBay',
    replyTo: String(cfg.Item?.notifyEmail ?? ''),
    subject: `Reminder: ${booking.serviceName} ${when} at ${displayTime(String(booking.startsAt), timezone)}`,
    text: [
      `${booking.name ?? 'Hi'},`,
      '',
      `A reminder about your ${booking.serviceName} with ${tenant?.name ?? 'us'}:`,
      `${when} at ${displayTime(String(booking.startsAt), timezone)}.`,
      '',
      `Can't make it? Cancel here so the time goes to someone else:`,
      `https://chat.makerbay.app/booking/cancel?slug=${tenant?.slug ?? ''}&token=${booking.cancelToken}`,
      '',
      tenant?.name ?? '',
    ].join('\n'),
  })
  if (notice.sent) {
    await emitUsage({ tenantId: event.tenantId, moduleId: 'booking', metric: 'reminder.sent', quantity: 1 })
  }
}
