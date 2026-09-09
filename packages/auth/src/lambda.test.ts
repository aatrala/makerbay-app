import { describe, expect, it } from 'vitest'
import { toRequest, toResult } from './lambda'

/**
 * The seam between API Gateway and Better Auth. Everything Better Auth
 * decides - origin checks, cookie parsing, the raw body a signature covers -
 * depends on this being faithful in both directions.
 */
const event = (over: Record<string, unknown> = {}) => ({
  version: '2.0',
  routeKey: 'POST /auth/{proxy+}',
  rawPath: '/auth/sign-in/email-otp',
  rawQueryString: '',
  headers: { host: 'api.makerbay.app', 'content-type': 'application/json', origin: 'https://app.makerbay.app' },
  requestContext: { domainName: 'api.makerbay.app', http: { method: 'POST', path: '/auth/sign-in/email-otp' } },
  body: '{"email":"a@b.c","otp":"123456"}',
  isBase64Encoded: false,
  ...over,
})

describe('toRequest', () => {
  it('rebuilds the public URL, method, headers and body', async () => {
    const r = toRequest(event() as never)
    expect(r.url).toBe('https://api.makerbay.app/auth/sign-in/email-otp')
    expect(r.method).toBe('POST')
    expect(r.headers.get('origin')).toBe('https://app.makerbay.app')
    expect(await r.text()).toBe('{"email":"a@b.c","otp":"123456"}')
  })

  it('keeps the query string', () => {
    const r = toRequest(event({ rawPath: '/auth/callback/cognito', rawQueryString: 'code=abc&state=xyz', requestContext: { domainName: 'api.makerbay.app', http: { method: 'GET', path: '/auth/callback/cognito' } }, body: undefined }) as never)
    expect(r.url).toBe('https://api.makerbay.app/auth/callback/cognito?code=abc&state=xyz')
  })

  it('reassembles the cookies API Gateway split off into a header', () => {
    const r = toRequest(event({ cookies: ['a=1', 'b=2'] }) as never)
    expect(r.headers.get('cookie')).toBe('a=1; b=2')
  })

  it('decodes a base64 body byte for byte', async () => {
    const r = toRequest(event({ body: Buffer.from('{"x":"ü"}').toString('base64'), isBase64Encoded: true }) as never)
    expect(await r.text()).toBe('{"x":"ü"}')
  })

  it('sends no body on GET', () => {
    const r = toRequest(event({ requestContext: { domainName: 'api.makerbay.app', http: { method: 'GET', path: '/auth/get-session' } } }) as never)
    expect(r.body).toBeNull()
  })
})

describe('toResult', () => {
  it('maps status, headers, body and every Set-Cookie separately', async () => {
    const h = new Headers({ 'content-type': 'application/json', 'set-auth-token': 'tok' })
    h.append('set-cookie', 'better-auth.session_token=abc; Path=/; HttpOnly')
    h.append('set-cookie', 'other=1; Path=/')
    const out = await toResult(new Response('{"ok":true}', { status: 200, headers: h }))
    expect(out).toMatchObject({
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'set-auth-token': 'tok' },
      cookies: ['better-auth.session_token=abc; Path=/; HttpOnly', 'other=1; Path=/'],
      body: '{"ok":true}',
    })
    expect((out as { headers: Record<string, string> }).headers['set-cookie']).toBeUndefined()
  })

  it('omits the cookies array when there are none, as API Gateway prefers', async () => {
    const out = await toResult(new Response(null, { status: 302, headers: { location: 'https://app.makerbay.app/#ott=x' } }))
    expect(out).toMatchObject({ statusCode: 302, headers: { location: 'https://app.makerbay.app/#ott=x' }, body: '' })
    expect(out).not.toHaveProperty('cookies')
  })
})
