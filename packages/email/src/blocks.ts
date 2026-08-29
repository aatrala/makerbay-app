/**
 * The document model every MakerBay email is built from.
 *
 * The load-bearing decision: **the text part is not derived from the HTML.**
 * Both render from this same block list. That removes an html-to-text
 * dependency, makes it impossible for the two halves to drift, and keeps the
 * whole thing a pure function to assert on - the same shape as
 * `presence/api/src/render.ts`, which is documented as taking everything it
 * needs as arguments so its rules can be unit tested.
 */

export type Block =
  | { t: 'para'; text: string }
  /** One line, larger: the thing that happened, before the detail. */
  | { t: 'lede'; text: string }
  | { t: 'button'; label: string; href: string }
  | { t: 'link'; label: string; href: string }
  /** Booking details, quote lines: a label and a value per row. */
  | { t: 'rows'; rows: Array<[label: string, value: string]> }
  | { t: 'total'; label: string; value: string }
  /** Muted. Deposit terms, "we will only ask once". */
  | { t: 'note'; text: string }
  /** A one-time code. Large, spaced, selectable as text, never an image. */
  | { t: 'code'; value: string }
  | { t: 'rule' }

export interface EmailBrand {
  /** What the inbox list shows, which on a phone is all it shows. */
  name: string
  accent: string
  /*
   * There is deliberately no logoUrl or footerNote here (issue 131).
   *
   * Both were declared, computed on every send by getTenantBrand, and read by
   * nothing - renderEmail never referenced either. footerNote had gone further
   * than dead: it held "Sent by X via MakerBay", which now contradicts the
   * real footer rather than merely being ignored.
   *
   * A logo is worth having, but the field pointed at the presence hero photo,
   * which is a wide banner shot of a van or a shopfront. That is not a logo,
   * and putting it in an email header would look like a mistake. Real logo
   * support needs a real logo upload, which is issue 90.
   */
}

export interface EmailDoc {
  brand: EmailBrand
  subject: string
  /** The grey line after the subject. Adds a fact the subject does not carry. */
  preheader: string
  heading: string
  blocks: Block[]
  /** Review asks and the digest ONLY. Never on an invoice or a confirmation. */
  unsubscribe?: { url: string; mailto: string }
}

/** MakerBay writing to an owner. A tenant's brand is built per-send. */
export const MAKERBAY_BRAND: EmailBrand = {
  name: 'MakerBay',
  accent: '#c2410c',
}
