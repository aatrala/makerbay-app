import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Resend adapter: what goes on the wire, and how the provider's answers
 * become the short error codes the dashboard already knows how to explain.
 */

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    async send() {
      return { SecretString: JSON.stringify({ apiKey: 're_test_123', webhookSecret: 'whsec_abc' }) }
    }
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}))

const calls: Array<{ url: string; init: RequestInit }> = []
let responses: Array<{ status: number; body: unknown }> = []

const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
  calls.push({ url, init })
  const next = responses.shift() ?? { status: 200, body: { id: 'em_1' } }
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    json: async () => next.body,
  }
})

const { sendViaResend, resendSuppression, removeResendSuppression, resendWebhookSecret, _resetResendCredentials } =
  await import('./resend')

beforeEach(() => {
  calls.length = 0
  responses = []
  process.env.RESEND_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:1:secret:makerbay/resend'
  vi.stubGlobal('fetch', fetchMock)
  _resetResendCredentials()
})
afterEach(() => vi.unstubAllGlobals())

const mail = {
  from: '"Southside Plumbing" <hello@send.makerbay.app>',
  to: 'homeowner@example.com',
  replyTo: 'joe@southside.example',
  subject: 'Your quote',
  text: 'Quote: https://x',
  html: '<p>Quote</p>',
  headers: { 'List-Unsubscribe': '<https://u>' },
  tags: { tenantId: '01HTEST', refType: 'quote', refId: 'Q1', audience: 'customer' },
}

describe('sendViaResend', () => {
  it('sends the whole message in the provider field names', async () => {
    const r = await sendViaResend(mail)
    expect(r).toEqual({ ok: true, messageId: 'em_1' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.resend.com/emails')
    const body = JSON.parse(String(calls[0].init.body))
    expect(body).toMatchObject({
      from: mail.from,
      to: ['homeowner@example.com'],
      reply_to: ['joe@southside.example'],
      subject: 'Your quote',
      text: 'Quote: https://x',
      html: '<p>Quote</p>',
      headers: { 'List-Unsubscribe': '<https://u>' },
    })
    expect(body.tags).toEqual([
      { name: 'tenantId', value: '01HTEST' },
      { name: 'refType', value: 'quote' },
      { name: 'refId', value: 'Q1' },
      { name: 'audience', value: 'customer' },
    ])
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer re_test_123')
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('never puts a character the provider rejects into a tag', async () => {
    await sendViaResend({ ...mail, tags: { refId: 'digest 2026/09/08' } })
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.tags[0].value).toBe('digest_2026_09_08')
  })

  it('retries once on a rate limit with the SAME idempotency key', async () => {
    responses = [{ status: 429, body: { name: 'rate_limit_exceeded' } }, { status: 200, body: { id: 'em_2' } }]
    const r = await sendViaResend(mail)
    expect(r).toEqual({ ok: true, messageId: 'em_2' })
    expect(calls).toHaveLength(2)
    const a = (calls[0].init.headers as Record<string, string>)['Idempotency-Key']
    const b = (calls[1].init.headers as Record<string, string>)['Idempotency-Key']
    expect(a).toBe(b)
  })

  it('does not retry a request the provider says is wrong', async () => {
    responses = [{ status: 422, body: { name: 'validation_error', message: 'bad to' } }]
    const r = await sendViaResend(mail)
    expect(r).toEqual({ ok: false, error: 'validation_error', detail: 'bad to' })
    expect(calls).toHaveLength(1)
  })

  it('reads an unverified domain as the same thing the SES sandbox was', async () => {
    responses = [{ status: 403, body: { name: 'validation_error', message: 'domain is not verified' } }]
    const r = await sendViaResend(mail)
    expect(r).toMatchObject({ ok: false, error: 'sandbox_or_rejected' })
  })

  it('names a spent quota rather than retrying into it', async () => {
    responses = [{ status: 429, body: { name: 'daily_quota_exceeded' } }]
    const r = await sendViaResend(mail)
    expect(r).toMatchObject({ ok: false, error: 'provider_quota' })
    expect(calls).toHaveLength(1)
  })

  it('reports a missing key without ever calling the API', async () => {
    delete process.env.RESEND_SECRET_ARN
    _resetResendCredentials()
    const r = await sendViaResend(mail)
    expect(r).toEqual({ ok: false, error: 'resend_not_configured' })
    expect(calls).toHaveLength(0)
  })
})

describe('suppression', () => {
  it('reads an entry back in the shape the staff console shows', async () => {
    responses = [{ status: 200, body: { email: 'x@y.z', origin: 'bounce', created_at: '2026-09-01T00:00:00Z' } }]
    expect(await resendSuppression('X@Y.Z')).toEqual({ suppressed: true, reason: 'bounce', since: '2026-09-01T00:00:00Z' })
    expect(calls[0].url).toBe('https://api.resend.com/suppressions/x%40y.z')
  })

  it('treats 404 as not suppressed on both lookup and removal', async () => {
    responses = [{ status: 404, body: { name: 'not_found' } }, { status: 404, body: {} }]
    expect(await resendSuppression('x@y.z')).toEqual({ suppressed: false })
    expect(await removeResendSuppression('x@y.z')).toBe(false)
    expect(calls[1].init.method).toBe('DELETE')
  })
})

describe('webhook secret', () => {
  it('comes from the same secret as the API key', async () => {
    expect(await resendWebhookSecret()).toBe('whsec_abc')
  })
})
