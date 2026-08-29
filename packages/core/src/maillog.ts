import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from './db'
import { findContactByIdentity } from './contacts'

/**
 * What happened to an email after we handed it over (issue 107).
 *
 * Before this, `notifyError` recorded only synchronous API failure, so a
 * message SES accepted and then hard-bounced left the row reading "sent" and
 * the "email failed" chip in the dashboard could never fire for a real
 * bounce. A tradesperson had no way to learn their customer never got the
 * quote.
 *
 * Two things live here. The log, which is per-message and answers "did she
 * get it?". And the per-tenant address status, which is the important one:
 * provider suppression is account-wide, so one tenant's bounce would
 * otherwise suppress that address for EVERY tenant, and two plumbers sharing
 * a customer is not hypothetical.
 */

const TABLE = () => process.env.TABLE_MAILLOG!

export type MailState =
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'delayed'
  | 'rejected'

export interface MailRef {
  tenantId: string
  moduleId: string
  refType: 'booking' | 'quote' | 'invoice' | 'request' | 'review' | 'auth' | 'setup' | 'ticket'
  refId: string
}

export interface MailLogRow {
  tenantId: string
  messageId: string
  state: MailState
  to: string
  audience: 'owner' | 'customer' | 'staff'
  refType?: string
  refId?: string
  /** GSI key, so "did she get the quote?" is one query. */
  refKey?: string
  /** SES bounce classification. Permanent means the address is dead. */
  bounceType?: string
  bounceSubType?: string
  diagnostic?: string
  at: string
  /** See RANK. Stored so the conditional write can compare against it. */
  rank?: number
  expiresAt: number
}

/**
 * How final each outcome is. One row per message, so a later event must not
 * be able to erase a more significant earlier one.
 *
 * This is not hypothetical: SES sends Delivery AND THEN Complaint for the same
 * message, EventBridge does not promise order, and the unconditional write
 * this replaces lost the complaint whenever the delivery landed second. The
 * mailbox simulator caught it - no unit test would have, because the ordering
 * is the bug.
 *
 * `delivered` outranks `delayed` so a message that was slow and then arrived
 * reads as arrived. Everything that means "it did not get there" outranks
 * both.
 */
const RANK: Record<MailState, number> = {
  sent: 0,
  delayed: 1,
  delivered: 2,
  rejected: 3,
  bounced: 4,
  complained: 5,
}

export async function recordMailEvent(row: Omit<MailLogRow, 'expiresAt' | 'rank'>): Promise<void> {
  const rank = RANK[row.state] ?? 0
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE(),
      Item: {
        ...row,
        rank,
        // Thirteen months, matching the audit trail: long enough to answer a
        // dispute, short enough not to accumulate forever.
        expiresAt: Math.floor(Date.now() / 1000) + 400 * 24 * 60 * 60,
      },
      // First event wins the row; after that only a more final outcome may
      // replace it. `rank` is aliased because unaliased attribute names in an
      // expression are how the reserved-keyword bug got in last time.
      ConditionExpression: 'attribute_not_exists(messageId) OR #rank <= :rank',
      ExpressionAttributeNames: { '#rank': 'rank' },
      ExpressionAttributeValues: { ':rank': rank },
    }))
  } catch (err) {
    // Losing the race is the expected outcome for a stale event, not a fault.
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return
    throw err
  }
}

export async function mailForRef(
  tenantId: string,
  refType: string,
  refId: string,
): Promise<MailLogRow[]> {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE(),
    IndexName: 'byRef',
    KeyConditionExpression: 'tenantId = :t AND refKey = :r',
    ExpressionAttributeValues: { ':t': tenantId, ':r': `${refType}#${refId}` },
  })).catch(() => ({ Items: [] }))
  return (r.Items ?? []) as MailLogRow[]
}

// ── Per-tenant address status ────────────────────────────────────────────

export type EmailStatus = 'ok' | 'bounced' | 'complained' | 'unsubscribed'

const statusKey = (tenantId: string, email: string) => ({
  tenantId,
  messageId: `addr#${email.trim().toLowerCase()}`,
})

/**
 * Mark an address as undeliverable FOR THIS TENANT.
 *
 * Deliberately not the provider's global list. A complaint especially is a
 * relationship between one business and one customer: someone marking a
 * plumber's booking confirmation as spam should not stop a different plumber
 * emailing the same person about a different job.
 */
export async function setEmailStatus(
  tenantId: string,
  email: string,
  status: EmailStatus,
  reason?: string,
): Promise<void> {
  if (!email?.includes('@')) return
  await ddb.send(new UpdateCommand({
    TableName: TABLE(),
    Key: statusKey(tenantId, email),
    // Every name aliased. `at` and `state` are both DynamoDB reserved keywords,
    // and an unaliased one is a ValidationException at runtime that no unit
    // test with a mocked client can catch - this cost a live debugging round.
    UpdateExpression: 'SET #s = :s, #reason = :r, #at = :a',
    ExpressionAttributeNames: { '#s': 'state', '#reason': 'reason', '#at': 'at' },
    ExpressionAttributeValues: {
      ':s': status,
      ':r': (reason ?? '').slice(0, 300),
      ':a': new Date().toISOString(),
    },
  }))
  // Mirror onto the contact so the dashboard can show it where the customer
  // actually is, rather than only in a staff console.
  try {
    const contact = await findContactByIdentity(tenantId, email)
    if (contact) {
      const { updateContact } = await import('./contacts')
      await updateContact(tenantId, contact.contactId, { emailStatus: status } as never)
    }
  } catch (err) {
    console.warn('contact emailStatus mirror failed', { tenantId, err: String(err) })
  }
}

/**
 * Checked before every send. A hard bounce means the address is dead, so
 * sending again costs money and reputation for a message nobody reads.
 *
 * A complaint blocks only the mail a recipient can reasonably object to.
 * Someone who marked a review request as spam has still asked a business for
 * a quote, and refusing to send them that quote would break the product to
 * respect a preference they did not express.
 */
export async function emailBlocked(
  tenantId: string,
  email: string,
  /** True for a review ask or a digest: mail a recipient can object to. */
  optional: boolean,
): Promise<false | EmailStatus> {
  if (!email?.includes('@')) return false
  try {
    const r = await ddb.send(new GetCommand({ TableName: TABLE(), Key: statusKey(tenantId, email) }))
    const status = r.Item?.state as EmailStatus | undefined
    if (status === 'bounced') return 'bounced'
    if (status === 'complained' && optional) return 'complained'
    // Asked to stop, so stop - but only the mail they can object to. Someone
    // who unsubscribed from review requests is still owed the invoice for the
    // work, and withholding it to honour a preference they never expressed
    // about invoices would be the wrong reading of what they asked for.
    if (status === 'unsubscribed' && optional) return 'unsubscribed'
    return false
  } catch {
    // A status we cannot read must never become a send we refuse: losing a
    // booking confirmation is worse than one wasted send.
    return false
  }
}
