import { MAKERBAY_BRAND } from '../blocks'
import { ownerFooter } from '../footers'
import { renderEmail } from '../render'
import { APP_HOST } from './people'

/**
 * The tripwire for a device being added to, or removed from, someone's
 * sign-in (issue 158 part B).
 *
 * A passkey outlives "sign out everywhere": a stolen session that registers
 * one keeps a way back in after the session is revoked. So EVERY add and
 * every remove emails the account, and the email says where the list is
 * and how to undo it. Like the code emails it carries no link - the address
 * is typed - and it never uses the word "passkey" in the heading, because
 * nobody in this audience knows it.
 */
export const passkeyChanged = (p: {
  action: 'added' | 'removed'
  /** The label the device was saved under, e.g. "iPhone" or "Windows PC". */
  deviceName: string
  /** Already formatted for the reader, e.g. "on Tuesday 9 September at 2:15pm (AEST)". */
  when: string
}) => {
  const added = p.action === 'added'
  return renderEmail(
    {
      brand: MAKERBAY_BRAND,
      subject: added
        ? 'A device can now sign in to your MakerBay account'
        : 'A device was removed from your MakerBay sign-in',
      preheader: added
        ? `${p.deviceName} can sign in with a fingerprint or face instead of a code.`
        : `${p.deviceName} can no longer sign in with a fingerprint or face.`,
      heading: added ? 'A device was added to your sign-in' : 'A device was removed from your sign-in',
      blocks: [
        { t: 'lede', text: `"${p.deviceName}" was ${added ? 'added' : 'removed'} ${p.when}.` },
        {
          t: 'para',
          text: added
            ? 'That device can now sign in to your MakerBay account with its fingerprint, face or PIN, '
              + 'with no code to wait for. Your emailed code still works everywhere else.'
            : 'That device can no longer sign in with its fingerprint or face. It can still sign in with '
              + 'an emailed code, like any other device.',
        },
        { t: 'para', text: 'If this was you, there is nothing to do.' },
        { t: 'rule' },
        {
          t: 'note',
          text: `If this was not you, someone else has been in your account. Sign in at ${APP_HOST}, open `
            + 'Your account, and remove any device you do not recognise. Then write to support@makerbay.app '
            + 'so we can look into it. Nobody from MakerBay will ever phone, text or email you asking for '
            + 'a sign-in code.',
        },
      ],
    },
    // A security email: no preference link, nothing to unsubscribe from.
    ownerFooter('your business'),
  )
}
