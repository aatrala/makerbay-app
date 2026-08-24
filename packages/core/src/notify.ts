import { randomBytes } from 'node:crypto'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

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

export interface EmailInput {
  to: string
  subject: string
  text: string
  replyTo?: string
}

const FROM = () => process.env.EMAIL_FROM ?? 'hello@makerbay.app'
const CONFIG_SET = () => process.env.EMAIL_CONFIG_SET

export async function sendEmail(input: EmailInput): Promise<EmailResult> {
  const to = input.to?.trim()
  if (!to || !to.includes('@')) return { sent: false, error: 'no_recipient' }

  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: FROM(),
        Destination: { ToAddresses: [to] },
        ...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
        ConfigurationSetName: CONFIG_SET(),
        Content: {
          Simple: {
            Subject: { Data: input.subject.slice(0, 200) },
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
// Integer minor units everywhere. No float ever touches a price.

export const money = (cents: number, currency = 'AUD'): string =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(cents / 100)

/** Line total, rounded once, so a hand-added column matches the invoice. */
export const lineTotalCents = (quantity: number, unitCents: number): number =>
  Math.round(quantity * unitCents)

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
