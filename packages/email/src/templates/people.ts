import { MAKERBAY_BRAND } from '../blocks'
import { ownerFooter } from '../footers'
import { PLATFORM, platformLine } from '../platform'
import { renderEmail } from '../render'

/** The owner footer says "you run X on MakerBay"; an invitee does not, yet. */
const inviteeFooter = (businessName: string, inviterEmail: string): string[] => [
  PLATFORM.productName,
  `You are getting this because ${inviterEmail} added this address to ${businessName} on ${PLATFORM.productName}.`,
  platformLine(PLATFORM),
  `${PLATFORM.productName} will never ask you for your password or a sign-in code.`,
]

/**
 * Mail about who is in a workspace (issue 158).
 *
 * The invitation carries **no link**, and that is the point of it. A code
 * email with a button is what a forged code email looks like, which is why
 * the sign-in codes have none; an invitation with a button leads to a page
 * that immediately asks for a code, which is the same pretext with a
 * business name on it. So the invitation says where to go and what will
 * happen, and the person types the address they already know. After they
 * sign in, the invitation is waiting.
 */

export const APP_HOST = 'app.makerbay.app'

export const invitation = (i: {
  businessName: string
  inviterEmail: string
  /** The address that was invited, so the recipient knows which one to sign in with. */
  email: string
}) =>
  renderEmail(
    {
      brand: MAKERBAY_BRAND,
      subject: `${i.businessName} has added you to MakerBay`,
      preheader: 'Sign in with this email address and the invitation will be waiting.',
      heading: `You have been added to ${i.businessName}`,
      blocks: [
        { t: 'lede', text: `${i.inviterEmail} wants you to see the diary, enquiries and quotes for ${i.businessName}.` },
        {
          t: 'para',
          text: `Sign in at ${APP_HOST} with this email address, ${i.email}, and the invitation will be waiting. `
            + 'It works for a week.',
        },
        {
          t: 'para',
          text: 'MakerBay will email you a six-digit code to sign in. There is no password, and nobody from '
            + 'MakerBay will ever phone, text or email you asking for the code.',
        },
        { t: 'rule' },
        {
          t: 'note',
          text: 'If you were not expecting this, ignore it. Nothing happens unless you sign in and choose to join.',
        },
      ],
    },
    inviteeFooter(i.businessName, i.inviterEmail),
  )

/** To the person who was removed, or who left. Plain, no link. */
export const removed = (r: { businessName: string; left: boolean }) =>
  renderEmail(
    {
      brand: MAKERBAY_BRAND,
      subject: r.left ? `You have left ${r.businessName}` : `You no longer have access to ${r.businessName}`,
      preheader: 'Your sign-in still works; the workspace is no longer yours to see.',
      heading: r.left ? `You have left ${r.businessName}` : `Access to ${r.businessName} has ended`,
      blocks: [
        {
          t: 'lede',
          text: r.left
            ? `You chose to leave ${r.businessName} on MakerBay.`
            : `The owner of ${r.businessName} has removed you from their MakerBay workspace.`,
        },
        {
          t: 'para',
          text: 'Anything you added while you were there - quotes, notes, bookings - stays with the business. '
            + 'Your sign-in still works, and you can create a workspace of your own any time.',
        },
      ],
    },
    ownerFooter(r.businessName),
  )
