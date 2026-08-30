import { randomBytes } from 'node:crypto'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { emailBlocked, type MailRef } from './maillog'
import { unsubTokenFor, unsubUrl } from './unsubscribe'

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
  /**
   * Skip the daily send cap (issue 134).
   *
   * ONLY for mail that completes a promise already made to this customer: a
   * reminder for an appointment we confirmed, or the confirmation for a
   * deposit they have already paid. Both fire hours or days after the action
   * that caused them, and a cap spent in between must not swallow them.
   *
   * Not a way to make an important email important. Everything customer-bound
   * feels important; the test is whether the customer is already expecting
   * this specific message because of something that has happened.
   */
  exempt?: boolean
  /**
   * The HTML part (issue 94).
   *
   * Optional, and the text part is never derived from it - both render from
   * the same block list in packages/email, so the two halves cannot drift.
   * Without it the message goes out text-only, which is what every module did
   * before the templates landed and remains a valid thing to send.
   */
  html?: string
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
   *
   * Optional here, REQUIRED by the `customer` audience below: the suppression
   * check, the daily cap and bounce attribution all hang off it, and a
   * customer-bound call site that forgot it would silently bypass all three.
   * The compiler keeps the tenth sender covered, not convention.
   */
  ref?: MailRef
  /**
   * True for mail a recipient can reasonably object to: a review ask, a
   * digest. Someone who reported one of those as spam is still owed their
   * invoice, so only optional mail is stopped by a complaint.
   */
  optional?: boolean
  /**
   * A pre-resolved unsubscribe token, when the caller already minted one to
   * render the template's footer. Passing it saves sendEmail resolving the
   * same address a second time for the List-Unsubscribe header - and keeps
   * header and footer agreeing, because both came from one resolution.
   */
  unsubToken?: string
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
  | (EmailBase & { audience: 'customer'; fromName: string; replyTo: string; ref: MailRef })

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

  /*
   * The daily send cap (issue 134).
   *
   * One choke point, so all nine customer-bound paths are covered without a
   * single call site changing - and so a tenth added tomorrow is covered on
   * the day it is written.
   *
   * Only customer-bound mail counts. Mail to the owner is mail they asked for
   * about their own business; capping it would mean withholding "you have a
   * new booking" from somebody having a good day.
   *
   * `exempt` is for messages that are the second half of a promise already
   * made: a reminder for an appointment we confirmed, or the confirmation for
   * a deposit already paid. Both fire hours or days after the thing that
   * caused them, and a cap spent in between must not swallow them.
   */
  if (input.audience === 'customer' && input.ref && !input.exempt) {
    const { tierFor, claimSend } = await import('./sendcap')
    const { getTenant } = await import('./db')
    const { isPaidWorkspace } = await import('./entitlements')
    const tenantId = input.ref.tenantId
    let limits
    try {
      // Independent reads, so they run together rather than in series - this
      // sits inside the choke point every customer send passes through.
      const [tenant, paid] = await Promise.all([getTenant(tenantId), isPaidWorkspace(tenantId)])
      limits = tierFor({
        payoutsEnabled: tenant?.payoutsEnabled,
        paid,
        // Written by the payments module the moment Stripe Connect
        // onboarding completes, so it already means exactly "verified since".
        verifiedSince: tenant?.connectOnboardedAt,
        sendingRestrictedAt: tenant?.sendingRestrictedAt,
      })
    } catch (err) {
      // A lookup failure must never cut off a paying customer mid-day, so
      // assume tier 1 rather than tier 0. The same asymmetry emailBlocked
      // uses: a status we cannot read must not become a send we refuse.
      console.error('send tier lookup failed, assuming verified', { tenantId, err: String(err) })
      limits = { tier: 1 as const, transactionalPerDay: 200, optionalPerDay: 50 }
    }
    const optional = input.optional === true
    const limit = optional ? limits.optionalPerDay : limits.transactionalPerDay
    const claim = await claimSend(tenantId, optional, limit)
    if (!claim.ok) {
      return { sent: false, error: optional ? 'daily_optional_limit' : 'daily_send_limit' }
    }
  }

  /**
   * A way out that is not the spam button (issue 121).
   *
   * Only on `optional` mail - review asks and digests. Everything else is
   * transactional: the customer asked for it, and a quote with an unsubscribe
   * link invites somebody to opt out of the document they are waiting for.
   *
   * Both the header and a line of text. The header is what Gmail and Apple
   * Mail turn into their own one-tap control, and what their bulk-sender rules
   * require above 5,000 messages a day; the text line is for every client that
   * shows neither.
   */
  let unsub: string | undefined
  if (input.optional && input.ref) {
    const token = input.unsubToken ?? (await unsubTokenFor(input.ref.tenantId, to))
    if (token) unsub = unsubUrl(token)
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
            Body: {
              Text: {
                /*
                 * The line is appended only for an UNTEMPLATED message. A
                 * templated one already carries the address in both parts,
                 * because renderEmail writes it into the HTML footer and the
                 * text together from one source - appending again would print
                 * it twice.
                 */
                Data: unsub && !input.html
                  ? `${input.text}

—
Don't want these? Stop them here:
${unsub}`
                  : input.text,
              },
              // Both parts, so a client that refuses HTML still gets a whole
              // message rather than an empty one.
              ...(input.html ? { Html: { Data: input.html } } : {}),
            },
            // SESv2 carries custom headers on Simple content, so this needs no
            // move to raw MIME - which the codebase had been bracing for since
            // issue 109 and which would have meant hand-building every message.
            ...(unsub
              ? {
                  Headers: [
                    { Name: 'List-Unsubscribe', Value: `<${unsub}>` },
                    // RFC 8058. Without it the mail client shows a link rather
                    // than its own one-tap control, and the bulk-sender rules
                    // are not satisfied.
                    { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
                  ],
                }
              : {}),
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
  /*
   * The send caps (issue 134). These read on the owner's own screen, so they
   * say what happened, why, and what to do - the product promises honest
   * errors rather than a spinner, and "limit exceeded" is a spinner in words.
   */
  if (error === 'daily_optional_limit') {
    return 'Review requests are switched off until your business is verified. '
      + 'Connect Stripe to take payments and they turn on straight away - it also '
      + 'proves you are a real business, which is what keeps our email out of spam '
      + 'folders.'
  }
  if (error === 'daily_send_limit') {
    return 'This business has sent all the emails it can today. It will send again '
      + 'tomorrow, or connect Stripe to lift the limit. Send the link yourself in '
      + 'the meantime.'
  }
  if (error === 'address_bounced') {
    return 'That address bounced last time, so nothing was sent. Check it on the contact and try again.'
  }
  if (error === 'address_complained') {
    return 'This customer has asked not to receive email, so nothing was sent.'
  }
  if (error === 'address_unsubscribed') {
    return 'This customer unsubscribed from these messages, so nothing was sent. Quotes and invoices still reach them.'
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
