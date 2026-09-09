import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import type { DeliveryResult, OutboundMail } from './types'

/**
 * Amazon SES. The original provider, and still the one Cognito's own mail and
 * the event pipeline's alarms are built around. It stays fully wired so the
 * cutover back is an environment variable and a deploy - but while the
 * account sits in the sandbox it can only reach verified addresses, which is
 * why the switch exists (issue 76).
 */

const ses = new SESv2Client({})

const CONFIG_SET = () => process.env.EMAIL_CONFIG_SET

export async function sendViaSes(mail: OutboundMail): Promise<DeliveryResult> {
  try {
    const r = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: mail.from,
        Destination: { ToAddresses: [mail.to] },
        ...(mail.replyTo ? { ReplyToAddresses: [mail.replyTo] } : {}),
        ConfigurationSetName: CONFIG_SET(),
        ...(mail.tags
          ? { EmailTags: Object.entries(mail.tags).map(([Name, Value]) => ({ Name, Value })) }
          : {}),
        Content: {
          Simple: {
            Subject: { Data: mail.subject },
            Body: {
              Text: { Data: mail.text },
              // Both parts, so a client that refuses HTML still gets a whole
              // message rather than an empty one.
              ...(mail.html ? { Html: { Data: mail.html } } : {}),
            },
            // SESv2 carries custom headers on Simple content, so this needs
            // no move to raw MIME.
            ...(mail.headers
              ? { Headers: Object.entries(mail.headers).map(([Name, Value]) => ({ Name, Value })) }
              : {}),
          },
        },
      }),
    )
    return { ok: true, messageId: r.MessageId }
  } catch (err) {
    const name = (err as { name?: string }).name ?? 'unknown'
    const message = String((err as { message?: string }).message ?? '')
    // The sandbox shows up in two different disguises. MessageRejected is the
    // documented one; the other is an AccessDeniedException naming the
    // *recipient* as an SES identity, because in the sandbox SES authorises
    // against the destination rather than the sender. Both mean the same
    // thing to a customer, and neither is a permissions bug to chase.
    const sandboxDenial = name === 'AccessDeniedException' && /identity\/[^'\s]+@/.test(message)
    return {
      ok: false,
      error: name === 'MessageRejected' || sandboxDenial ? 'sandbox_or_rejected' : name,
      detail: message,
    }
  }
}
