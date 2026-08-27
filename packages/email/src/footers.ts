/**
 * The two footers, defined once.
 *
 * They differ because the recipients do. An owner has a relationship with
 * MakerBay and can change what we send them. Their customer has neither: a
 * homeowner who booked a plumber has never heard of us, must never be offered
 * a MakerBay preference page, and their opt-out is a conversation with the
 * tradesperson, not a link from us.
 */

/** Replace before a single email ships. This is legally load-bearing. */
export const POSTAL_ADDRESS = 'MakerBay Pty Ltd, 14 Wilson Street, Newtown NSW 2042, Australia'

export const ownerFooter = (businessName: string, options?: { security?: boolean }): string[] => [
  'MakerBay',
  `You are getting this because you run ${businessName} on MakerBay.`,
  // A security email offers no preference link: there is nothing to
  // unsubscribe from, and a link in one is a phishing vector in itself.
  ...(options?.security ? [] : ['Choose which emails we send: https://app.makerbay.app/settings/notifications']),
  POSTAL_ADDRESS,
  'MakerBay will never ask you for your password or a sign-in code.',
]

export const customerFooter = (
  businessName: string,
  contact: { phone?: string; email?: string },
  reason: string,
): string[] => [
  businessName,
  [contact.phone, contact.email].filter(Boolean).join(' · '),
  reason,
  // MakerBay is the sender of record and cannot publish an address it has not
  // verified, so this carries ours rather than the tradesperson's.
  `Sent for ${businessName} by ${POSTAL_ADDRESS}.`,
].filter((l) => l !== '')
