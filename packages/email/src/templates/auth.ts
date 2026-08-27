import { MAKERBAY_BRAND } from '../blocks'
import { ownerFooter } from '../footers'
import { renderEmail } from '../render'

/**
 * The code emails, rendered at synth time and handed to Cognito as static
 * templates. Same renderer as every other MakerBay email, so the one a
 * tradesperson gets when they sign in cannot drift from the one telling them
 * a customer booked.
 *
 * Three rules these follow that the others do not:
 *
 * 1. **The code goes in the subject line.** Someone standing in a kitchen
 *    reads it off the notification without opening anything, which is both
 *    faster and safer than making them open mail to get it.
 * 2. **No link. At all.** A code email containing a button means a spoofed
 *    code email containing a button is indistinguishable, and the habit that
 *    trains is the vulnerability. Addresses are typed out to be typed in.
 * 3. **"phone, text or email".** The realistic attack on a sole trader is not
 *    a spoofed email, it is a phone call while their hands are full: someone
 *    says there is a problem with a booking and a code has just been sent.
 *    "We will never email you asking" leaves that wide open.
 */

export type AuthKind = 'verify' | 'reset' | 'signin'

/** Cognito substitutes this itself. It must survive into the output verbatim. */
export const CODE_PLACEHOLDER = '{####}'

const NEVER_ASKS =
  'Type it into the MakerBay page you already have open. Nobody from MakerBay will ever '
  + 'phone, text or email you asking for it. Anyone who does is trying to get into your '
  + 'account and take your customer list.'

const COPY: Record<AuthKind, { subject: string; heading: string; lede: string; expiry: string; ifNotYou: string }> = {
  verify: {
    subject: `${CODE_PLACEHOLDER} is your MakerBay code`,
    heading: 'Your MakerBay code',
    lede: 'Enter this to finish setting up your account.',
    expiry: 'It expires in 15 minutes and can be used once.',
    ifNotYou:
      'If you did not just sign up for MakerBay, ignore this email. Nothing has been created '
      + 'and no account exists yet.',
  },
  reset: {
    subject: `${CODE_PLACEHOLDER} is your MakerBay reset code`,
    heading: 'Your password reset code',
    lede: 'Enter this to choose a new password.',
    expiry: 'It expires in 15 minutes and can be used once.',
    ifNotYou:
      'If you did not ask to reset your password, ignore this email. Your password has not '
      + 'been changed and nobody has been let in. If this keeps arriving and you did not ask '
      + 'for it, write to support@makerbay.app.',
  },
  signin: {
    subject: `${CODE_PLACEHOLDER} is your MakerBay sign-in code`,
    heading: 'Your sign-in code',
    lede: 'Enter this to sign in.',
    expiry: 'It expires in 10 minutes and works once.',
    ifNotYou:
      'If you did not just try to sign in, someone else has your email address and is trying '
      + 'to get in. Ignore this email - they cannot get in without the code - and write to '
      + 'support@makerbay.app.',
  },
}

export function authEmail(kind: AuthKind): { subject: string; html: string; text: string } {
  const c = COPY[kind]
  return renderEmail(
    {
      brand: MAKERBAY_BRAND,
      subject: c.subject,
      preheader: `${c.expiry} MakerBay will never ask you for this code.`,
      heading: c.heading,
      blocks: [
        { t: 'lede', text: c.lede },
        { t: 'code', value: CODE_PLACEHOLDER },
        { t: 'para', text: c.expiry },
        { t: 'para', text: NEVER_ASKS },
        { t: 'rule' },
        { t: 'note', text: c.ifNotYou },
      ],
    },
    // No preference link on a security email: there is nothing to unsubscribe
    // from, and offering one is a phishing vector in itself.
    ownerFooter('your business', { security: true }),
  )
}
