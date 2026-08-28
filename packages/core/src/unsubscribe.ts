import { randomBytes } from 'node:crypto'
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from './db'
import { setEmailStatus } from './maillog'

/**
 * Letting a recipient stop mail without reporting it as spam (issue 121).
 *
 * Until this, the only way a homeowner could stop a review request was the
 * spam button - the single most damaging deliverability signal there is, on a
 * domain shared by every tenant. One annoyed customer of one plumber degraded
 * delivery for all of them.
 *
 * Only `optional` mail carries this: review asks and digests. A quote, an
 * invoice, a booking confirmation and a password reset are transactional - the
 * customer asked for them - and an unsubscribe link on a security email is a
 * phishing vector, which is why `authEmail` deliberately has none.
 *
 * WHY A STORED TOKEN RATHER THAN A SIGNED ONE: an HMAC needs a signing key,
 * which needs managing, rotating and keeping out of logs. A random token
 * stored beside the address it belongs to needs none of that, matches how
 * `linkToken` already works everywhere else in this codebase, and is
 * revocable. It costs one write the first time an address is mailed and
 * nothing afterwards.
 */

const TABLE = () => process.env.TABLE_MAILLOG!

/**
 * The reverse lookup lives under a reserved partition.
 *
 * The MailLog table is keyed (tenantId, messageId). Parking the token index
 * under a tenantId no real tenant can have keeps it out of every genuine
 * query - `mailForRef` filters by a real tenant, and the address-status key is
 * `addr#...` - without a second table or a second index.
 *
 * A lowercase hyphenated string is deliberately unlike a tenant id, which is
 * always a 26-character uppercase ULID, so the two can never collide. An
 * earlier version used a leading space for the same purpose and a stray NUL
 * byte got into the literal instead - which made every unsubscribe link
 * resolve to nothing, silently, because the write and the read agreed with
 * each other and with nothing else.
 */
const TOKEN_PARTITION = 'unsub-token'

const addressKey = (tenantId: string, email: string) => ({
  tenantId,
  messageId: `unsub#${email.trim().toLowerCase()}`,
})

/**
 * The token for an address, created once and reused.
 *
 * Stable on purpose: a customer who unsubscribes from a link in an old email
 * must still be unsubscribed, and rotating per message would leave every
 * previously sent link dead.
 */
export async function unsubTokenFor(tenantId: string, email: string): Promise<string | undefined> {
  const clean = email?.trim().toLowerCase()
  if (!clean?.includes('@')) return undefined
  try {
    const existing = await ddb.send(new GetCommand({
      TableName: TABLE(),
      Key: addressKey(tenantId, clean),
    }))
    const found = existing.Item?.token as string | undefined
    if (found) return found

    const token = randomBytes(18).toString('base64url')
    await ddb.send(new PutCommand({
      TableName: TABLE(),
      Item: { ...addressKey(tenantId, clean), token, createdAt: new Date().toISOString() },
    }))
    // The reverse row, so a click resolves without an index.
    await ddb.send(new PutCommand({
      TableName: TABLE(),
      Item: {
        tenantId: TOKEN_PARTITION,
        messageId: token,
        forTenant: tenantId,
        email: clean,
        createdAt: new Date().toISOString(),
      },
    }))
    return token
  } catch (err) {
    // A missing unsubscribe link must never stop the email itself. The
    // alternative - refusing to send - is worse for everyone, and the
    // recipient still has the complaint button.
    console.warn('unsubscribe token failed', { tenantId, err: String(err) })
    return undefined
  }
}

export interface UnsubTarget {
  tenantId: string
  email: string
}

/** Who a token belongs to. Undefined for anything we did not issue. */
export async function resolveUnsub(token: string): Promise<UnsubTarget | undefined> {
  const clean = String(token ?? '').trim()
  // Shape check first: the token is 18 random bytes, so anything else is not
  // ours and should not become a database read.
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(clean)) return undefined
  try {
    const r = await ddb.send(new GetCommand({
      TableName: TABLE(),
      Key: { tenantId: TOKEN_PARTITION, messageId: clean },
    }))
    const row = r.Item
    return row?.forTenant && row?.email
      ? { tenantId: String(row.forTenant), email: String(row.email) }
      : undefined
  } catch (err) {
    console.warn('unsubscribe resolve failed', { err: String(err) })
    return undefined
  }
}

/**
 * Record the request.
 *
 * Per tenant, like every other address state: unsubscribing from one
 * tradesperson's review requests must not stop a different tradesperson
 * emailing the same person about their own job.
 */
export async function applyUnsubscribe(target: UnsubTarget): Promise<void> {
  await setEmailStatus(target.tenantId, target.email, 'unsubscribed', 'requested by recipient')
}

/** The address a recipient visits. Public, and it must work without sign-in. */
export const unsubUrl = (token: string): string =>
  `https://api.makerbay.app/v1/public/unsubscribe?t=${encodeURIComponent(token)}`
