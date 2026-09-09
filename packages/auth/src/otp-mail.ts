import { sendEmail } from '@makerbay/core'
import { authEmail, CODE_PLACEHOLDER, type AuthKind } from '@makerbay/email'

/**
 * The sign-in code, through the same pipeline as every other MakerBay email
 * (issue 157). Better Auth hands us the code; the template is the one
 * Cognito used, with the placeholder filled in here rather than by Cognito.
 *
 * A failed send throws, but Better Auth runs this through its background
 * task wrapper, which awaits it and then swallows the error - the API still
 * answers `success: true` (create-context.mjs, `runInBackgroundOrAwait`).
 * So the login page cannot be told. The last time an auth email failed
 * silently, sign-up was broken for three days before anyone noticed, which
 * is why the `sign-in code not sent` line below feeds a CloudWatch metric
 * filter and an alarm in the AuthStack: a failed code is a page, not a log.
 */
type OtpType = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email'

const KIND: Record<OtpType, AuthKind> = {
  'sign-in': 'signin',
  'email-verification': 'verify',
  'forget-password': 'reset',
  'change-email': 'verify',
}

/** Pure: the rendered message with the code substituted. Exported for the tests. */
export function otpMessage(type: OtpType, otp: string): { subject: string; text: string; html: string } {
  const m = authEmail(KIND[type])
  const fill = (s: string) => s.split(CODE_PLACEHOLDER).join(otp)
  return { subject: fill(m.subject), text: fill(m.text), html: fill(m.html) }
}

export async function sendOtp({ email, otp, type }: { email: string; otp: string; type: OtpType }): Promise<void> {
  const m = otpMessage(type, otp)
  const r = await sendEmail({ to: email, audience: 'owner', subject: m.subject, text: m.text, html: m.html })
  if (!r.sent) {
    console.error('sign-in code not sent', { type, error: r.error, to: email.replace(/^(.).*(@.*)$/, '$1***$2') })
    throw new Error(`otp_send_failed:${r.error ?? 'unknown'}`)
  }
}
