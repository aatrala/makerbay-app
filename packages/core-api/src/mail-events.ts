import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { notificationsBroken } from '@makerbay/email'
import {
  COMPLAINT_BRAKE,
  countComplaint,
  recordMailEvent,
  resendWebhookSecret,
  restrictSending,
  sendEmail,
  setEmailStatus,
  verifySvix,
  type MailState,
} from '@makerbay/core'

/**
 * What the provider tells us after it has taken a message (issue 107).
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
 *
 * Two doors, one room (issue 156). SES arrives through EventBridge; Resend
 * posts a signed webhook to /v1/mail/webhook, which lands on this same
 * function. The webhook is verified, then translated into the SES event
 * shape below, so everything from the suppression rule to the complaint
 * brake exists exactly once and behaves identically whichever provider is
 * live.
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

type Inbound = { detail?: SesEvent } | APIGatewayProxyEventV2

const isHttp = (e: Inbound): e is APIGatewayProxyEventV2 =>
  typeof (e as APIGatewayProxyEventV2).requestContext?.http?.method === 'string'

export const handler = async (event: Inbound): Promise<APIGatewayProxyResultV2 | void> => {
  if (isHttp(event)) return await webhook(event)
  await processEvent(event.detail)
}

/**
 * Resend's webhook. No authorizer on the route: the signature over the raw
 * body is the authentication, and a request that fails it is dropped with a
 * 400 before anything is parsed. Anything that fails AFTER verification is
 * allowed to throw, so the provider retries it and the mail-events alarm sees
 * it - a bounce silently swallowed is the exact state issue 107 was filed
 * to end.
 */
async function webhook(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '')
  const h: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(event.headers ?? {})) h[k.toLowerCase()] = v

  let secret: string
  try {
    secret = await resendWebhookSecret()
  } catch (err) {
    console.error('resend webhook secret unavailable', { err: String(err) })
    return { statusCode: 503, body: 'not_configured' }
  }
  const ok = verifySvix({
    secret,
    id: h['svix-id'],
    timestamp: h['svix-timestamp'],
    signature: h['svix-signature'],
    body: raw,
  })
  if (!ok) {
    console.warn('resend webhook signature rejected', { id: h['svix-id'] })
    return { statusCode: 400, body: 'invalid_signature' }
  }

  let payload: ResendEvent
  try {
    payload = JSON.parse(raw)
  } catch {
    return { statusCode: 400, body: 'bad_json' }
  }
  await processEvent(fromResend(payload))
  return { statusCode: 200, body: 'ok' }
}

interface ResendEvent {
  type?: string
  data?: {
    email_id?: string
    to?: string[] | string
    tags?: Record<string, unknown> | Array<{ name?: string; value?: unknown }>
    bounce?: { type?: string; subType?: string; message?: string }
    failed?: { reason?: string }
  }
}

/** Resend event types, in terms of the SES ones the consumer already models. */
const RESEND_TYPES: Record<string, string> = {
  'email.sent': 'Send',
  'email.delivered': 'Delivery',
  'email.delivery_delayed': 'DeliveryDelay',
  'email.bounced': 'Bounce',
  'email.complained': 'Complaint',
  'email.failed': 'Reject',
  // The provider refused to send because the address is on its own
  // suppression list. To the row that is a permanent bounce: the message
  // did not go, and will not, until somebody clears the address.
  'email.suppressed': 'Bounce',
}

/**
 * One provider's vocabulary into the other's. Exported for the tests, which
 * feed it the documented payloads verbatim.
 */
export function fromResend(p: ResendEvent | undefined): SesEvent | undefined {
  const eventType = p?.type ? RESEND_TYPES[p.type] : undefined
  if (!eventType) return undefined
  const d = p!.data ?? {}
  const tags: Record<string, string[]> = {}
  if (Array.isArray(d.tags)) {
    for (const t of d.tags) if (t?.name) tags[t.name] = [String(t.value ?? '')]
  } else if (d.tags && typeof d.tags === 'object') {
    for (const [k, v] of Object.entries(d.tags)) tags[k] = [String(v ?? '')]
  }
  const to = Array.isArray(d.to) ? d.to.map(String) : d.to ? [String(d.to)] : []
  const out: SesEvent = { eventType, mail: { messageId: d.email_id, destination: to, tags } }
  if (p!.type === 'email.bounced') {
    out.bounce = {
      // Resend uses SES's own classification: Permanent, Transient, Undetermined.
      bounceType: d.bounce?.type ?? 'Permanent',
      bounceSubType: d.bounce?.subType,
      bouncedRecipients: to.map((a) => ({ emailAddress: a, diagnosticCode: d.bounce?.message })),
    }
  } else if (p!.type === 'email.suppressed') {
    out.bounce = {
      bounceType: 'Permanent',
      bounceSubType: 'Suppressed',
      bouncedRecipients: to.map((a) => ({ emailAddress: a, diagnosticCode: 'On the provider suppression list' })),
    }
  } else if (p!.type === 'email.complained') {
    out.complaint = { complainedRecipients: to.map((a) => ({ emailAddress: a })) }
  } else if (p!.type === 'email.failed') {
    // Not a bounce: nothing is known about the address, only that the
    // provider could not take the message. Keep the reason as the diagnostic.
    out.bounce = { bouncedRecipients: to.map((a) => ({ emailAddress: a, diagnosticCode: d.failed?.reason })) }
  }
  return out
}

async function processEvent(d: SesEvent | undefined): Promise<void> {
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

    /*
     * The auto-brake (issue 134).
     *
     * A workspace generating complaints is the one thing that can cost every
     * other workspace their deliverability, and at our volume a handful in a
     * day is already far above the rate a provider will tolerate. So it
     * stops sending optional mail without waiting for a human.
     *
     * It restricts sending rather than suspending the account. Suspension is
     * refused at the authorizer, which would lock the owner out of the
     * dashboard - including the screen that would tell them what happened and
     * let them argue with us about it.
     */
    const complaints = await countComplaint(tenantId)
    if (complaints >= COMPLAINT_BRAKE) {
      await restrictSending(tenantId, `${complaints} spam reports in 24 hours`)
      console.error('sending restricted', { tenantId, complaints })
    }
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
    const mail = notificationsBroken({
      businessName: tenant?.name ?? 'your workspace',
      bounced,
    })
    await sendEmail({
      to: owner.email,
      audience: 'owner',
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    })
  } catch (err) {
    console.error('owner bounce notice failed', { tenantId, err: String(err) })
  }
}
