import { randomBytes } from 'node:crypto'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { emailBlocked, type MailRef } from './maillog'

/**
 * One email sender for every module.
 *
 * It never throws. A notification that fails must not lose the booking or the
 * request that caused it - the customer's write already succeeded, and losing
 * it to a mail problem would be far worse than a missing email. Callers store
 * the returned error on the row and show it in the dashboard so the owner
 * knows to follow up by hand.
 */

const ses = new SESv2Client({})

export interface EmailResult {
  sent: boolean
  /** Short reason, safe to store and show. Absent when sent. */
  error?: string
}

/**
 * Anything a tenant typed that reaches a mail header. A business name flows
 * into the display name and the subject, and it is attacker-controlled text
 * that lands in strangers' inboxes on a domain we authenticate. Under
 * Content.Simple a CRLF is harmless; under Raw, which List-Unsubscribe needs,
 * it is header injection. Sanitise at the boundary now, before the HTML work
 * makes Raw attractive. (issue 109)
 */
export const headerSafe = (s: string): string =>
  String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 78)

interface EmailBase {
  to: string
  subject: string
  text: string
  replyTo?: string
  /**
   * The name the recipient sees in their inbox list, which on a phone is the
   * ONLY thing they see before deciding. Owner mail leaves this unset and
   * arrives as MakerBay.
   */
  fromName?: string
  /**
   * What this email is about, so a bounce three seconds later can be traced
   * back to the quote that caused it (issue 107). SES EmailTags values allow
   * only alphanumerics, hyphens and underscores - ULIDs are Crockford base32
   * uppercase, so they pass unmodified.
   */
  ref?: MailRef
  /**
   * True for mail a recipient can reasonably object to: a review ask, a
   * digest. Someone who reported one of those as spam is still owed their
   * invoice, so only optional mail is stopped by a complaint.
   */
  optional?: boolean
}

/**
 * Who is receiving this, declared at every call site on purpose.
 *
 * `customer` means the tenant's own customer: a homeowner who booked a
 * plumber, who has never heard of MakerBay. Their mail must wear the
 * tradesperson's name and carry a Reply-To that reaches them, so the type
 * makes both mandatory. Before this, eight of nine customer-bound emails had
 * no Reply-To and there is no inbound mail on the domain, so those replies
 * were being discarded. (issues 103, 105, 106)
 */
export type EmailInput =
  | (EmailBase & { audience: 'owner' | 'staff' })
  | (EmailBase & { audience: 'customer'; fromName: string; replyTo: string })

const FROM = () => process.env.EMAIL_FROM ?? 'hello@makerbay.app'
/**
 * Customer mail will move to its own verified subdomain so a homeowner marking
 * spam cannot damage the domain our security emails come from. Until that
 * identity is verified this is unset and customer mail keeps the same envelope
 * address, wearing the business name in the display name. That display name is
 * what the inbox shows, so it is most of the fix on its own.
 */
const FROM_CUSTOMER = () => process.env.EMAIL_FROM_CUSTOMER
const CONFIG_SET = () => process.env.EMAIL_CONFIG_SET

/** RFC 5322 display name. Quoted and escaped, never interpolated raw. */
const addressWithName = (name: string | undefined, address: string): string => {
  const clean = headerSafe(name ?? '')
  if (!clean) return address
  return `"${clean.replace(/["\\]/g, '')}" <${address}>`
}

export async function sendEmail(input: EmailInput): Promise<EmailResult> {
  const to = input.to?.trim()
  if (!to || !to.includes('@')) return { sent: false, error: 'no_recipient' }

  // Refuse before spending anything on an address we already know is dead.
  // Per-tenant, not the provider's account-wide list: one tenant's bounce
  // must not silence that address for every other tenant (issue 107).
  if (input.ref) {
    const blocked = await emailBlocked(input.ref.tenantId, to, input.optional === true)
    if (blocked) return { sent: false, error: `address_${blocked}` }
  }

  try {
    const envelope = input.audience === 'customer' ? (FROM_CUSTOMER() ?? FROM()) : FROM()
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: addressWithName(input.fromName, envelope),
        Destination: { ToAddresses: [to] },
        ...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
        ConfigurationSetName: CONFIG_SET(),
        // Carried back on every delivery, bounce and complaint event, so the
        // handler can find the row that caused the message without keeping a
        // second index of its own.
        ...(input.ref
          ? {
              EmailTags: [
                { Name: 'tenantId', Value: input.ref.tenantId },
                { Name: 'refType', Value: input.ref.refType },
                { Name: 'refId', Value: input.ref.refId },
                { Name: 'audience', Value: input.audience },
              ],
            }
          : {}),
        Content: {
          Simple: {
            Subject: { Data: headerSafe(input.subject).slice(0, 200) },
            Body: { Text: { Data: input.text } },
          },
        },
      }),
    )
    return { sent: true }
  } catch (err) {
    const name = (err as { name?: string }).name ?? 'unknown'
    // The name alone is useless for diagnosis - AccessDeniedException does not
    // say which permission. Log the message; never surface it to a customer.
    console.warn('email send detail', {
      name,
      message: (err as { message?: string }).message,
      from: FROM(),
      configSet: CONFIG_SET(),
    })
    // The sandbox shows up in two different disguises. MessageRejected is the
    // documented one; the other is an AccessDeniedException naming the
    // *recipient* as an SES identity, because in the sandbox SES authorises
    // against the destination rather than the sender. Both mean the same thing
    // to a customer, and neither is a permissions bug to chase.
    const message = String((err as { message?: string }).message ?? '')
    const sandboxDenial = name === 'AccessDeniedException' && /identity\/[^'\s]+@/.test(message)
    const error = name === 'MessageRejected' || sandboxDenial ? 'sandbox_or_rejected' : name
    console.warn('email send failed', { to: to.replace(/^(.).*(@.*)$/, '$1***$2'), error })
    return { sent: false, error }
  }
}

/** Human wording for a stored send failure. */
export function explainEmailError(error?: string): string | undefined {
  if (!error) return undefined
  if (error === 'no_recipient') return 'No email address was given, so nothing was sent.'
  // Written back onto the row by the SES event consumer, after the send
  // itself succeeded. These are the ones that answer "she says she never got
  // it" - the whole point of issue 107.
  if (error === 'bounced') {
    return 'This did not reach them: their email address rejected it permanently. Check the address, or ring them.'
  }
  if (error === 'bounce_transient') {
    return 'Not delivered yet: their mail server turned it away, often a full mailbox. It may still arrive.'
  }
  if (error === 'complained') {
    return 'They marked this as spam. Nothing further will be sent to them automatically.'
  }
  if (error === 'address_bounced') {
    return 'That address bounced last time, so nothing was sent. Check it on the contact and try again.'
  }
  if (error === 'address_complained') {
    return 'This customer has asked not to receive email, so nothing was sent.'
  }
  if (error === 'sandbox_or_rejected') {
    return 'Email is not switched on for this account yet, so nothing was sent. Send the link yourself for now.'
  }
  return `The notification could not be sent (${error}). Follow up by hand.`
}

/**
 * An opaque link token. This is a credential: it grants access to exactly one
 * booking or quote with no sign-in, so it must be unguessable, which rules out
 * anything derived from the record's own id.
 */
export const linkToken = (): string => randomBytes(24).toString('base64url')

/** Timing-safe-ish compare. Tokens are random, but never leak length by early exit. */
export const tokenMatches = (a?: string, b?: string): boolean => {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ── Money ────────────────────────────────────────────────────────────────
// Moved to ./money when the en-AU hardcoding turned out to render every
// foreign currency wrong (issue 114). Re-exported so the many callers that
// import it from here keep working.

// ── SMS ──────────────────────────────────────────────────────────────────
// Same contract as sendEmail: never throws, failures are recorded on the row
// and shown in the dashboard. Until an origination number is registered with
// AWS End User Messaging, every send reports sms_not_configured - the flows
// still work, the message text is kept, and the dashboard says so plainly.

import { PinpointSMSVoiceV2Client, SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2'

const smsClient = new PinpointSMSVoiceV2Client({})

export interface SmsResult {
  sent: boolean
  error?: string
}

export async function sendSms(to: string, text: string): Promise<SmsResult> {
  const origination = process.env.SMS_ORIGINATION
  if (!origination) return { sent: false, error: 'sms_not_configured' }
  const dest = to?.trim()
  if (!dest || !/^\+?[0-9]{7,15}$/.test(dest.replace(/[\s()-]/g, ''))) {
    return { sent: false, error: 'no_recipient' }
  }
  try {
    await smsClient.send(
      new SendTextMessageCommand({
        DestinationPhoneNumber: dest.replace(/[\s()-]/g, ''),
        OriginationIdentity: origination,
        MessageBody: text.slice(0, 480),
      }),
    )
    return { sent: true }
  } catch (err) {
    const name = (err as { name?: string }).name ?? 'unknown'
    console.warn('sms send failed', { error: name })
    return { sent: false, error: name }
  }
}

export function explainSmsError(error?: string): string | undefined {
  if (!error) return undefined
  if (error === 'sms_not_configured') {
    return 'Text messaging is not switched on for this account yet, so the text was not sent.'
  }
  if (error === 'no_recipient') return 'The caller withheld their number, so no text could be sent.'
  return `The text could not be sent (${error}).`
}

/**
 * The address a customer's reply should reach.
 *
 * Customer-bound mail must always carry a Reply-To that lands somewhere a
 * tradesperson reads, because there is no inbound mail on makerbay.app and a
 * reply without one is discarded (issue 106). Not every module stores a
 * notify address of its own - reviews and visibility do not - so this
 * resolves the best available: whatever the module knows, then the owner's
 * own sign-in address.
 */
export async function ownerReplyTo(tenantId: string, preferred?: string): Promise<string> {
  const p = (preferred ?? '').trim()
  if (p.includes('@')) return p
  const { listTenantUsers } = await import('./db')
  const users = await listTenantUsers(tenantId)
  const owner = users.find((u) => u.role === 'owner') ?? users[0]
  return owner?.email ?? ''
}
