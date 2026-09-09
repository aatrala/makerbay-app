import { sendViaResend } from './resend'
import { sendViaSes } from './ses'
import type { DeliveryResult, MailProvider, OutboundMail } from './types'

export * from './types'
export { verifySvix, type SvixInput } from './svix'
export {
  removeResendSuppression,
  resendSuppression,
  resendWebhookSecret,
  type ProviderSuppression,
} from './resend'

/**
 * Which provider carries mail in this deployment (issue 156).
 *
 * One active provider, chosen by the stack and never per call. Both stay
 * configured in DNS and in code so the cutover in either direction is an
 * environment variable and a deploy. Deliberately NOT a failover: two live
 * providers means two suppression lists that never reconcile, and a retry
 * after one of them accepted the message sends the customer two invoices.
 */
export const activeMailProvider = (): MailProvider =>
  process.env.EMAIL_PROVIDER === 'resend' ? 'resend' : 'ses'

/**
 * Put one already-decided message on the wire with the active provider.
 *
 * Below sendEmail on purpose: it carries none of the product's guarantees
 * (no suppression check, no cap, no escaping). The only caller besides
 * sendEmail is the staff console's diagnostic, which exists to prove the
 * provider works and must therefore not go through sendEmail.
 */
export function deliver(mail: OutboundMail): Promise<DeliveryResult> {
  return activeMailProvider() === 'resend' ? sendViaResend(mail) : sendViaSes(mail)
}
