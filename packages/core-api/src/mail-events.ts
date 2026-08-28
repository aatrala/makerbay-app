import { recordMailEvent, sendEmail, setEmailStatus, type MailState } from '@makerbay/core'

/**
 * What SES tells us after it has taken a message (issue 107).
 *
 * The config set now has an event destination, so bounces and complaints
 * reach this instead of being generated and discarded. Before it, a hard
 * bounce left the row reading "sent" and a tradesperson had no way to learn
 * their customer never got the quote.
 *
 * EventBridge rather than SNS, on the DEFAULT bus: SES will not publish to a
 * custom one, so the `makerbay` bus is not an option here and the rule filters
 * on `source: aws.ses` instead. The usage-metering contract on our own bus is
 * untouched by this.
 */

interface SesEvent {
  eventType: string
  mail?: {
    messageId?: string
    destination?: string[]
    tags?: Record<string, string[]>
  }
  bounce?: {
    bounceType?: string
    bounceSubType?: string
    bouncedRecipients?: Array<{ emailAddress?: string; diagnosticCode?: string }>
  }
  complaint?: {
    complainedRecipients?: Array<{ emailAddress?: string }>
    complaintFeedbackType?: string
  }
}

const STATE: Record<string, MailState> = {
  Send: 'sent',
  Delivery: 'delivered',
  Bounce: 'bounced',
  Complaint: 'complained',
  DeliveryDelay: 'delayed',
  Reject: 'rejected',
}

/** EmailTags come back as arrays of one. */
const tag = (e: SesEvent, name: string): string | undefined => e.mail?.tags?.[name]?.[0]

export const handler = async (event: { detail?: SesEvent }): Promise<void> => {
  const d = event.detail
  if (!d?.eventType) return
  const state = STATE[d.eventType]
  if (!state) return

  const tenantId = tag(d, 'tenantId')
  const messageId = d.mail?.messageId
  const to = d.bounce?.bouncedRecipients?.[0]?.emailAddress
    ?? d.complaint?.complainedRecipients?.[0]?.emailAddress
    ?? d.mail?.destination?.[0]
    ?? ''

  // Untagged mail predates the ref field, or is Cognito's, which carries no
  // tenant. Nothing to attribute it to, so there is nothing useful to record.
  if (!tenantId || !messageId) {
    if (state === 'bounced' || state === 'complained') {
      console.warn('untagged bounce or complaint', { eventType: d.eventType, to: mask(to) })
    }
    return
  }

  const audience = (tag(d, 'audience') ?? 'owner') as 'owner' | 'customer' | 'staff'
  await recordMailEvent({
    tenantId,
    messageId,
    state,
    to,
    audience,
    refType: tag(d, 'refType'),
    refId: tag(d, 'refId'),
    refKey: `${tag(d, 'refType') ?? 'none'}#${tag(d, 'refId') ?? 'none'}`,
    bounceType: d.bounce?.bounceType,
    bounceSubType: d.bounce?.bounceSubType,
    diagnostic: d.bounce?.bouncedRecipients?.[0]?.diagnosticCode?.slice(0, 300),
    at: new Date().toISOString(),
  })

  // A Transient bounce is a full mailbox or a server having a bad afternoon.
  // Suppressing on one would lose a customer a real message, so only a
  // Permanent bounce marks the address dead.
  if (state === 'bounced') {
    // The row is marked for a transient bounce too: the owner still wants to
    // know the message has not arrived yet, even though the address survives.
    await markRow(tenantId, tag(d, 'refType'), tag(d, 'refId'),
      d.bounce?.bounceType === 'Permanent' ? 'bounced' : 'bounce_transient')
  }
  if (state === 'bounced' && d.bounce?.bounceType === 'Permanent') {
    await setEmailStatus(tenantId, to, 'bounced', d.bounce?.bounceSubType)
    await tellOwner(tenantId, to, audience)
  }
  if (state === 'complained') {
    // Recorded, and it stops optional mail. The owner is NOT told their
    // customer reported them as spam: it is usually a misclick, and telling
    // them creates a support conversation and a grudge over nothing.
    await setEmailStatus(tenantId, to, 'complained', d.complaint?.complaintFeedbackType)
    await markRow(tenantId, tag(d, 'refType'), tag(d, 'refId'), 'complained')
    console.warn('complaint', { tenantId, to: mask(to) })
  }
}

const mask = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2')

/**
 * Where the row that caused this message lives.
 *
 * Recording the bounce in MailLog is not enough on its own: the dashboard's
 * "email failed" chip reads `notifyError` on the module row, which is written
 * at send time and never touched again. A message SES accepts and hard-bounces
 * thirty seconds later would still show as sent, which is exactly the
 * complaint issue 107 was filed about. So the state goes back on the row.
 *
 * Every module keys its table (tenantId, <thing>Id), so a small registry is
 * enough. A refType with no entry is simply not written back rather than
 * guessed at.
 */
const ROWS: Record<string, { table: () => string | undefined; key: string }> = {
  quote: { table: () => process.env.TABLE_QUOTES, key: 'quoteId' },
  invoice: { table: () => process.env.TABLE_INVOICES, key: 'invoiceId' },
  booking: { table: () => process.env.TABLE_BOOKINGS, key: 'bookingId' },
  request: { table: () => process.env.TABLE_REQUESTS, key: 'requestId' },
}

/**
 * Put the delivery outcome back on the row the customer's dashboard shows.
 *
 * Only bounces and complaints are written. A delivery must NOT clear
 * `notifyError`, because a message can be delivered to one address while
 * having failed for another reason worth keeping, and because clearing an
 * error nobody has seen yet hides the problem.
 */
async function markRow(
  tenantId: string,
  refType: string | undefined,
  refId: string | undefined,
  error: string,
): Promise<void> {
  const spec = refType ? ROWS[refType] : undefined
  const table = spec?.table()
  // A digest refId is synthetic and matches no row; so is anything from a
  // module with no table wired. Nothing to update, and that is not an error.
  if (!spec || !table || !refId || refId.startsWith('digest-')) return
  try {
    const { ddb } = await import('@makerbay/core')
    const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb')
    await ddb.send(new UpdateCommand({
      TableName: table,
      Key: { tenantId, [spec.key]: refId },
      UpdateExpression: 'SET notifyError = :e',
      // Never create a row that is not there. A bounce for a deleted quote
      // must not resurrect it as a stub with nothing in it but an error.
      ConditionExpression: 'attribute_exists(tenantId)',
      ExpressionAttributeValues: { ':e': error },
    }))
  } catch (err) {
    const name = (err as { name?: string }).name
    if (name === 'ConditionalCheckFailedException') return
    console.warn('row writeback failed', { tenantId, refType, err: String(err) })
  }
}

/**
 * A bounce on the OWNER's own notification address is a silent product
 * failure: they think they have no work coming in. Everything else can wait
 * for them to look at the row in the dashboard.
 */
async function tellOwner(tenantId: string, bounced: string, audience: string): Promise<void> {
  if (audience !== 'owner') return
  try {
    const { getTenant, listTenantUsers } = await import('@makerbay/core')
    const [tenant, users] = await Promise.all([getTenant(tenantId), listTenantUsers(tenantId)])
    const owner = users.find((u) => u.role === 'owner') ?? users[0]
    // Do not write to the address that just bounced.
    if (!owner?.email || owner.email.toLowerCase() === bounced.toLowerCase()) return
    await sendEmail({
      to: owner.email,
      audience: 'owner',
      subject: 'Your notification email is not working',
      text: [
        `Emails to ${bounced} are bouncing, so ${tenant?.name ?? 'your workspace'} is not being told`,
        'about new bookings, requests or quotes going out.',
        '',
        'Nothing has been lost. Everything is still in your dashboard, and the moment you fix the',
        'address the notifications start again.',
        '',
        'Change it under Booking, Hours, or Requests, Settings.',
      ].join('\n'),
    })
  } catch (err) {
    console.error('owner bounce notice failed', { tenantId, err: String(err) })
  }
}
