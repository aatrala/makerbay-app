/**
 * What a provider is handed, after sendEmail has done everything that makes a
 * MakerBay email a MakerBay email: the suppression check, the daily cap, the
 * header escaping, the unsubscribe headers, the tags that let a bounce find
 * its row. Nothing below this line knows about tenants or quotes; it knows
 * how to put one already-decided message on the wire.
 */
export interface OutboundMail {
  /** RFC 5322 mailbox, display name already quoted: `"Acme" <hello@...>`. */
  from: string
  to: string
  replyTo?: string
  subject: string
  text: string
  html?: string
  /** Extra headers, e.g. List-Unsubscribe. Values already header-safe. */
  headers?: Record<string, string>
  /**
   * Carried back on every delivery, bounce and complaint event. Both providers
   * accept only `[A-Za-z0-9_-]` in names and values, so callers pass ULIDs and
   * short enums, never free text.
   */
  tags?: Record<string, string>
}

export type DeliveryResult =
  | { ok: true; messageId?: string }
  /** `error` is short and safe to store on a row; `detail` is for logs only. */
  | { ok: false; error: string; detail?: string }

/** Which service actually carries the mail. Chosen per deploy, never per call. */
export type MailProvider = 'ses' | 'resend'
