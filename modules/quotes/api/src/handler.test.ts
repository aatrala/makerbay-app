import { describe, expect, it, vi } from 'vitest'

/**
 * The four pre-existing defects found while scoping issue 118. Each is a
 * regression test, not a feature test: the point is that they stay fixed once
 * link-first sharing makes all four far more likely to fire.
 */

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }))
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({ Items: [] }) }) },
  GetCommand: class {}, PutCommand: class {}, QueryCommand: class {},
  DeleteCommand: class {}, UpdateCommand: class {}, ScanCommand: class {},
}))
vi.mock('@aws-sdk/client-eventbridge', () => ({ EventBridgeClient: class {}, PutEventsCommand: class {} }))
vi.mock('@aws-sdk/client-sesv2', () => ({ SESv2Client: class {}, SendEmailCommand: class {} }))
vi.mock('@aws-sdk/client-pinpoint-sms-voice-v2', () => ({
  PinpointSMSVoiceV2Client: class {}, SendTextMessageCommand: class {},
}))

const { redactPath, respondGuard } = await import('./handler')

describe('redactPath', () => {
  const TOKEN = 'IdC_9xKq2mVvA1sPzR7bWnLe'

  // A token is a bearer credential: it grants read AND accept on one quote.
  // Logging the raw path put those in CloudWatch on every 500.
  it('removes the token from a quote path', () => {
    expect(redactPath(`/v1/public/quotes/${TOKEN}`)).toBe('/v1/public/quotes/{token}')
    expect(redactPath(`/v1/public/quotes/${TOKEN}`)).not.toContain(TOKEN)
  })

  it('removes it from the respond path too, keeping the action visible', () => {
    const out = redactPath(`/v1/public/quotes/${TOKEN}/respond`)
    expect(out).toBe('/v1/public/quotes/{token}/respond')
    expect(out).not.toContain(TOKEN)
  })

  // A log that hides which route failed is a different problem.
  it('leaves the literal invoice route readable', () => {
    expect(redactPath('/v1/public/quotes/invoice')).toBe('/v1/public/quotes/invoice')
  })

  it('leaves authenticated paths alone', () => {
    const p = '/v1/quotes/01J8ZXQ7T4Y9V2M6K3N5P8R1QW/send'
    expect(redactPath(p)).toBe(p)
  })

  it('survives odd input rather than throwing inside an error handler', () => {
    expect(redactPath('')).toBe('')
    expect(redactPath(undefined as never)).toBe('')
  })
})

/**
 * The superseded-accept hole. Revising a quote gives the customer a new link,
 * but the old one is still in their WhatsApp thread. Before this guard, a tap
 * on it recorded a binding acceptance at the OLD price.
 */
describe('respondGuard', () => {
  const q = (over: Record<string, unknown> = {}) =>
    ({ status: 'sent', ...over }) as never

  const parse = (r: unknown) => {
    const res = r as { statusCode: number; body: string }
    return { code: res.statusCode, body: JSON.parse(res.body) }
  }

  it('lets a normal accept through', () => {
    expect(respondGuard(q(), 'sent', 'accept')).toBeUndefined()
    expect(respondGuard(q(), 'sent', 'decline')).toBeUndefined()
  })

  it('refuses to accept a superseded quote', () => {
    const r = parse(respondGuard(q({ status: 'superseded' }), 'superseded', 'accept'))
    expect(r.code).toBe(409)
    expect(r.body.error).toBe('superseded')
  })

  // The row can still read 'sent' while the effective status has moved on.
  it('refuses when only the effective status says superseded', () => {
    const r = parse(respondGuard(q({ status: 'sent' }), 'superseded', 'accept'))
    expect(r.code).toBe(409)
    expect(r.body.error).toBe('superseded')
  })

  it('refuses to DECLINE a superseded quote too', () => {
    // Declining the withdrawn version would tell the business the customer
    // said no to an offer that is no longer on the table.
    expect(parse(respondGuard(q({ status: 'superseded' }), 'superseded', 'decline')).code).toBe(409)
  })

  it('points the customer at the version that replaced it', () => {
    const r = parse(respondGuard(
      q({ status: 'superseded', supersededByToken: 'NEWTOKEN123' }), 'superseded', 'accept',
    ))
    expect(r.body.supersededByToken).toBe('NEWTOKEN123')
  })

  it('omits the forward link rather than sending null when there is none', () => {
    const r = parse(respondGuard(q({ status: 'superseded' }), 'superseded', 'accept'))
    expect('supersededByToken' in r.body).toBe(false)
  })

  // Both true at once: "here is the new one" beats "this expired".
  it('prefers the superseded answer over expired, because it is actionable', () => {
    const r = parse(respondGuard(
      q({ status: 'superseded', supersededByToken: 'NEW' }), 'expired', 'accept',
    ))
    expect(r.body.error).toBe('superseded')
  })

  it('still refuses an expired quote', () => {
    expect(parse(respondGuard(q(), 'expired', 'accept')).code).toBe(409)
  })

  it('stays idempotent on a double tap', () => {
    const r = parse(respondGuard(q({ status: 'accepted' }), 'accepted', 'accept'))
    expect(r.code).toBe(200)
    expect(r.body.already).toBe(true)
  })

  // An already-accepted quote answers 200, not 409: the customer did nothing
  // wrong, and their acceptance stands.
  it('does not let a superseded check override a settled quote', () => {
    const r = parse(respondGuard(q({ status: 'accepted' }), 'superseded', 'accept'))
    expect(r.code).toBe(200)
  })

  it('rejects a decision it does not understand', () => {
    expect(parse(respondGuard(q(), 'sent', 'maybe')).code).toBe(400)
    expect(parse(respondGuard(q(), 'sent', '')).code).toBe(400)
  })
})
