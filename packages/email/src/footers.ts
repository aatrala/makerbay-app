import { PLATFORM, platformLine, type PlatformIdentity } from './platform'

/**
 * The two footers, defined once.
 *
 * They differ because the recipients do. An owner has a relationship with
 * MakerBay and can change what we send them. Their customer has neither: a
 * homeowner who booked a plumber has never heard of us, must never be offered
 * a MakerBay preference page, and their opt-out is a conversation with the
 * tradesperson, not a link from us.
 */

export const ownerFooter = (
  businessName: string,
  p: PlatformIdentity = PLATFORM,
): string[] => [
  p.productName,
  `You are getting this because you run ${businessName} on ${p.productName}.`,
  /*
   * No preferences link. This used to point at
   * app.makerbay.app/settings/notifications, which does not exist and never
   * has - a 404 promising control is worse than not offering it. The mail an
   * owner can actually opt out of (the daily digest) carries a real
   * unsubscribe of its own; everything else here is money or work arriving.
   *
   * A security email would offer nothing here regardless: a preference link
   * in one is a phishing vector.
   */
  platformLine(p),
  `${p.productName} will never ask you for your password or a sign-in code.`,
]

export const customerFooter = (
  businessName: string,
  contact: { phone?: string; email?: string },
  reason: string,
  p: PlatformIdentity = PLATFORM,
): string[] => [
  businessName,
  [contact.phone, contact.email].filter(Boolean).join(' · '),
  reason,
  /*
   * Two sentences, and both are load-bearing.
   *
   * The first names the sender, the business it is sending for, and the
   * relationship between them. Canada's CASL requires all three when you send
   * on someone else's behalf, and it is the strictest of the five markets this
   * ships to, so satisfying it satisfies the rest. It also happens to be what
   * an honest email would say.
   *
   * The second carries the postal address. It is separated from the first
   * because when the address sat on the same line it read as the
   * tradesperson's own - it appears directly under their name and phone
   * number, and a homeowner in Sydney has no reason to think otherwise. An
   * address that identifies the wrong company is worse than no address.
   */
  `Sent on behalf of ${businessName} by ${p.productName}, the booking software they use.`,
  platformLine(p),
].filter((l) => l !== '')
