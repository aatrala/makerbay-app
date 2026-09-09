import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Webhook signature check for the Svix scheme Resend uses (issue 156).
 *
 * Hand-rolled rather than a dependency: it is HMAC-SHA256 over three strings
 * joined by dots, and the whole point of a webhook endpoint with no
 * authorizer is that this function is the authorizer. Every line of it should
 * be readable in one sitting.
 *
 * Verified over the RAW body, never a re-serialised one - a single reordered
 * key or dropped space changes the digest.
 */
export interface SvixInput {
  /** `whsec_` followed by the base64 key, as shown in the provider's dashboard. */
  secret: string
  id?: string
  timestamp?: string
  /** Space-separated `v1,<base64>` entries. */
  signature?: string
  body: string
  nowMs?: number
  /** Replay window. Five minutes is the scheme's own recommendation. */
  toleranceSeconds?: number
}

export function verifySvix(input: SvixInput): boolean {
  const { id, timestamp, signature, body } = input
  if (!id || !timestamp || !signature || typeof body !== 'string') return false

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000)
  const tolerance = input.toleranceSeconds ?? 300
  if (Math.abs(now - ts) > tolerance) return false

  const encoded = input.secret.startsWith('whsec_') ? input.secret.slice(6) : input.secret
  let key: Buffer
  try {
    key = Buffer.from(encoded, 'base64')
  } catch {
    return false
  }
  if (key.length === 0) return false

  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest()

  for (const entry of signature.split(' ')) {
    const [version, sig] = entry.split(',')
    if (version !== 'v1' || !sig) continue
    let given: Buffer
    try {
      given = Buffer.from(sig, 'base64')
    } catch {
      continue
    }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true
  }
  return false
}
