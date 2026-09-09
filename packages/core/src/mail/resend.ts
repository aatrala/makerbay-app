import { randomUUID } from 'node:crypto'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import type { DeliveryResult, OutboundMail } from './types'

/**
 * Resend (issue 156).
 *
 * Why a second provider at all: the SES account was refused production
 * access twice (issue 76), and while it sits in the sandbox a customer of a
 * customer cannot receive the invoice they are waiting for. Resend verifies a
 * domain in minutes and sends from day one. Same DKIM-signed domains, same
 * tags, same bounce and complaint pipeline - the webhook in mail-events.ts
 * normalises its events into the shape the SES consumer already handles.
 *
 * Plain fetch rather than the SDK. The API is one POST, Node 22 has fetch,
 * and this code is bundled into eight Lambdas whose cold start is worth more
 * than a convenience wrapper.
 */

const API = 'https://api.resend.com'
const sm = new SecretsManagerClient({})

interface Credentials {
  apiKey: string
  webhookSecret: string
}

let cached: Credentials | undefined

/**
 * Credentials from Secrets Manager, cached for the life of the execution
 * environment and never logged. The secret is created by CDK with
 * placeholder values; the real ones are put in out of band and never pass
 * through a template, a log, or this repository.
 */
async function credentials(): Promise<Credentials> {
  if (cached) return cached
  const arn = process.env.RESEND_SECRET_ARN
  if (!arn) throw new Error('resend_not_configured')
  let raw: string
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }))
    raw = r.SecretString ?? ''
  } catch (err) {
    console.error('could not read resend secret', {
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : '',
    })
    throw new Error('resend_not_configured')
  }
  let parsed: Record<string, string>
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Shape only - no secret content in the log.
    console.warn('resend secret is not valid JSON', { length: raw.length })
    throw new Error('resend_not_configured')
  }
  const apiKey: string = parsed.apiKey ?? parsed.api_key ?? parsed.RESEND_API_KEY ?? ''
  const webhookSecret: string =
    parsed.webhookSecret ?? parsed.webhook_secret ?? parsed.signingSecret ?? parsed.RESEND_WEBHOOK_SECRET ?? ''
  // Resend keys are `re_...`. A placeholder left in from the CDK template is
  // the overwhelmingly likely way this fails, so say so rather than sending a
  // request that comes back 401 with nothing useful in it.
  if (!apiKey.startsWith('re_')) {
    console.warn('resend credentials unusable', {
      fieldsPresent: Object.keys(parsed),
      apiKeyPrefix: apiKey ? `${apiKey.slice(0, 3)}...` : '(empty)',
    })
    throw new Error('resend_not_configured')
  }
  cached = { apiKey, webhookSecret }
  return cached
}

/** The webhook signing secret, for mail-events.ts to verify inbound events. */
export async function resendWebhookSecret(): Promise<string> {
  const { webhookSecret } = await credentials()
  if (!webhookSecret.startsWith('whsec_')) throw new Error('resend_webhook_not_configured')
  return webhookSecret
}

/** Both providers accept only these characters in a tag. Anything else is replaced, not rejected. */
const tagSafe = (s: string): string => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256)

/**
 * The provider's error names, translated into the short codes the rest of
 * the product already stores and explains. Unknown names pass through so a
 * new failure mode is at least visible on the row rather than flattened.
 */
function mapError(status: number, name: string): string {
  if (status === 429 && /quota/.test(name)) return 'provider_quota'
  if (status === 429) return 'rate_limited'
  if (status === 401 || /api_key/.test(name)) return 'resend_not_configured'
  // Resend answers 403 validation_error when the From domain is not verified
  // or the account may only mail its own addresses - the same situation, to
  // a customer, as the SES sandbox.
  if (status === 403) return 'sandbox_or_rejected'
  return name || `http_${status}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function request(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { apiKey } = await credentials()
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8_000),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json }
}

export async function sendViaResend(mail: OutboundMail): Promise<DeliveryResult> {
  const body = {
    from: mail.from,
    to: [mail.to],
    ...(mail.replyTo ? { reply_to: [mail.replyTo] } : {}),
    subject: mail.subject,
    text: mail.text,
    ...(mail.html ? { html: mail.html } : {}),
    ...(mail.headers ? { headers: mail.headers } : {}),
    ...(mail.tags
      ? { tags: Object.entries(mail.tags).map(([name, value]) => ({ name: tagSafe(name), value: tagSafe(value) })) }
      : {}),
  }
  /*
   * One retry, and only with an idempotency key. A 5xx can arrive after the
   * provider has accepted the message, and a bare retry then sends the
   * customer two invoices. The key makes the second attempt a no-op if the
   * first one landed.
   */
  const idempotencyKey = randomUUID()
  let last: DeliveryResult = { ok: false, error: 'network_error' }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(600)
    let status: number
    let json: Record<string, unknown>
    try {
      const r = await request('POST', '/emails', body, { 'Idempotency-Key': idempotencyKey })
      status = r.status
      json = r.json
    } catch (err) {
      const message = String((err as Error)?.message ?? err)
      if (message === 'resend_not_configured') return { ok: false, error: 'resend_not_configured' }
      last = { ok: false, error: 'network_error', detail: message }
      continue
    }
    if (status >= 200 && status < 300) {
      return { ok: true, messageId: typeof json.id === 'string' ? json.id : undefined }
    }
    const name = typeof json.name === 'string' ? json.name : ''
    last = {
      ok: false,
      error: mapError(status, name),
      detail: typeof json.message === 'string' ? json.message : name,
    }
    // Retry a rate limit or a provider fault; never a request the provider
    // has told us is wrong.
    const retryable = (status === 429 && !/quota/.test(name)) || status >= 500
    if (!retryable) return last
  }
  return last
}

// ── Suppression list ─────────────────────────────────────────────────────
// Provider-wide, exactly like SES's. The per-tenant status in MailLog is what
// sendEmail actually checks; this is the staff console's escape hatch for
// "she says she never gets anything from anybody".

export interface ProviderSuppression {
  suppressed: boolean
  reason?: string
  since?: string
}

export async function resendSuppression(email: string): Promise<ProviderSuppression> {
  const { status, json } = await request('GET', `/suppressions/${encodeURIComponent(email.trim().toLowerCase())}`)
  if (status === 404) return { suppressed: false }
  if (status >= 200 && status < 300) {
    return {
      suppressed: true,
      reason: typeof json.origin === 'string' ? json.origin : undefined,
      since: typeof json.created_at === 'string' ? json.created_at : undefined,
    }
  }
  throw new Error(`resend_suppression_lookup_${status}`)
}

/** True if an entry was removed, false if there was nothing to remove. */
export async function removeResendSuppression(email: string): Promise<boolean> {
  const { status } = await request('DELETE', `/suppressions/${encodeURIComponent(email.trim().toLowerCase())}`)
  if (status === 404) return false
  if (status >= 200 && status < 300) return true
  throw new Error(`resend_suppression_remove_${status}`)
}

/** Test seam: forget cached credentials. */
export const _resetResendCredentials = (): void => {
  cached = undefined
}
