import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isPlatformJwt, issuerOf, verifyPlatformJwt } from './auth-token'

/**
 * The authorizer routes on the unverified issuer and then verifies. Both
 * halves have to be right: routing a Cognito token to the JWKS verifier
 * would reject every existing session, and accepting a token whose issuer
 * merely claims to be ours would be a hole the size of the product.
 */
const ISSUER = 'https://api.makerbay.app'

describe('issuerOf / isPlatformJwt', () => {
  beforeEach(() => { process.env.AUTH_ISSUER = ISSUER })
  afterEach(() => { delete process.env.AUTH_ISSUER })

  it('reads the issuer without verifying, and is false for anything else', () => {
    const unsigned = `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify({ iss: ISSUER, sub: 'u1' }))}.`
    expect(issuerOf(unsigned)).toBe(ISSUER)
    expect(isPlatformJwt(unsigned)).toBe(true)
    expect(isPlatformJwt('mb_sk_notajwt')).toBe(false)
    expect(issuerOf('garbage')).toBeUndefined()
  })

  it('is never true when no issuer is configured', () => {
    delete process.env.AUTH_ISSUER
    const unsigned = `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify({ iss: ISSUER }))}.`
    expect(isPlatformJwt(unsigned)).toBe(false)
  })
})

describe('verifyPlatformJwt', () => {
  let publicJwk: Record<string, unknown>
  let sign: (claims: Record<string, unknown>, opts?: { iss?: string; aud?: string; exp?: string }) => Promise<string>

  beforeEach(async () => {
    process.env.AUTH_ISSUER = ISSUER
    process.env.AUTH_JWKS_URL = `${ISSUER}/auth/jwks`
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
    publicJwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'EdDSA', use: 'sig' }
    sign = (claims, opts = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
        .setIssuer(opts.iss ?? ISSUER)
        .setAudience(opts.aud ?? ISSUER)
        .setIssuedAt()
        .setExpirationTime(opts.exp ?? '15m')
        .sign(privateKey)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.AUTH_ISSUER
    delete process.env.AUTH_JWKS_URL
  })

  it('accepts a token signed by the published key and returns the subject and email', async () => {
    const token = await sign({ sub: 'u1', email: 'joe@example.com' })
    await expect(verifyPlatformJwt(token)).resolves.toEqual({ sub: 'u1', email: 'joe@example.com' })
  })

  it('rejects the wrong audience, the wrong issuer, and an expired token', async () => {
    await expect(verifyPlatformJwt(await sign({ sub: 'u1' }, { aud: 'https://elsewhere' }))).rejects.toThrow()
    await expect(verifyPlatformJwt(await sign({ sub: 'u1' }, { iss: 'https://evil' }))).rejects.toThrow()
    await expect(verifyPlatformJwt(await sign({ sub: 'u1' }, { exp: '-1m' }))).rejects.toThrow()
  })

  it('rejects a token signed by a different key', async () => {
    const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
    const token = await new SignJWT({ sub: 'u1' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setIssuer(ISSUER).setAudience(ISSUER).setIssuedAt().setExpirationTime('15m')
      .sign(other.privateKey)
    await expect(verifyPlatformJwt(token)).rejects.toThrow()
  })
})
