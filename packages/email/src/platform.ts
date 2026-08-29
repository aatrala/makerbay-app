/**
 * Who is actually sending the mail (issue 131).
 *
 * Every email this product sends is from one of two senders: a tradesperson
 * writing to their own customer, or MakerBay writing to the tradesperson. In
 * both cases an anti-spam regime wants to know which legal entity pressed
 * send and where it can be reached, and until this file existed the answer
 * was a placeholder naming a company that does not exist.
 *
 * It is a constant rather than a setting, and that is deliberate. The Cognito
 * user pool renders `authEmail('verify').html` at CDK synth time and stores
 * the result inside the CloudFormation resource, so the sign-up email is a
 * build artifact - no runtime lookup can ever reach it. A database-backed
 * value would leave that one email permanently disagreeing with the other 21.
 * A constant is read the same way by esbuild (for the Lambdas) and by the CDK
 * process (for Cognito), so all 22 change together or not at all.
 *
 * Changing it is a deploy. That is the trade, and it is the right one for a
 * value that is legally load-bearing and changes about once per company.
 */

export interface PlatformIdentity {
  /** The company that exists on paper and is liable. */
  legalEntityName: string
  /** What the product is called, which is not the same thing. */
  productName: string
  /** A real postal address. Required by CAN-SPAM, CASL and the EU regime. */
  postalAddress: string
  /** A monitored inbox. Not a no-reply. */
  supportEmail: string
}

export const PLATFORM: PlatformIdentity = {
  legalEntityName: 'Appa Technologies Pty Ltd',
  productName: 'MakerBay',
  postalAddress: '4 Greenwood Place, Freshwater NSW 2096, Australia',
  supportEmail: 'support@makerbay.app',
}

/**
 * The sentence that names us. Both footers end with this, so a homeowner and
 * a business owner are told the same thing about who we are.
 */
export const platformLine = (p: PlatformIdentity = PLATFORM): string =>
  `${p.productName} is a product of ${p.legalEntityName}, ${p.postalAddress}.`
