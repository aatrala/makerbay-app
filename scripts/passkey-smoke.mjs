#!/usr/bin/env node
/**
 * Proves the passkey ceremony against the LIVE auth endpoints with a
 * software authenticator (issue 158 part B1).
 *
 * A browser pane has no fingerprint reader, so the WebAuthn half is played
 * here: a P-256 key in WebCrypto, an attestation object in the "none"
 * format, and an assertion signed the way an authenticator signs. It is
 * the same bytes a phone would send, minus the phone. What it proves:
 *
 *   1. a registration WITHOUT user verification is refused (the spec's
 *      "required" is enforced on the server, not just requested);
 *   2. a registration with it is stored under the name given;
 *   3. an anonymous browser can sign in with the credential and mint a
 *      token the API accepts, and one without user verification cannot;
 *   4. rename and remove work, and the list agrees.
 *
 * The add and remove emails are checked by hand afterwards in the Resend
 * dashboard (the address is a Resend test address).
 *
 * Usage:
 *   node scripts/passkey-smoke.mjs send  <email>          ask for a code
 *   node scripts/passkey-smoke.mjs run   <email> <code>   the whole loop
 */
import { webcrypto as crypto } from 'node:crypto'

const APP = process.env.AUTH_BASE_URL ?? 'https://app.makerbay.app'
const API = process.env.API_BASE ?? 'https://api.makerbay.app'
const RP_ID = process.env.AUTH_RP_ID ?? 'makerbay.app'
const enc = new TextEncoder()

// ── tiny helpers ─────────────────────────────────────────────────────────

const b64u = (bytes) => Buffer.from(bytes).toString('base64url')
const fromB64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'))
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** Enough CBOR for an attestation object and a COSE key. */
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Uint8Array.of((major << 5) | n)
    if (n < 0x100) return Uint8Array.of((major << 5) | 24, n)
    if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff)
    return Uint8Array.of((major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (v instanceof Uint8Array) return concat(head(2, v.length), v)
  if (typeof v === 'string') { const b = enc.encode(v); return concat(head(3, b.length), b) }
  if (v instanceof Map) {
    const parts = [head(5, v.size)]
    for (const [k, val] of v) parts.push(cbor(k), cbor(val))
    return concat(...parts)
  }
  if (v && typeof v === 'object') return cbor(new Map(Object.entries(v)))
  throw new Error(`cbor: unsupported ${typeof v}`)
}

/** WebCrypto gives r||s; WebAuthn wants DER. */
function derSignature(raw) {
  const int = (bytes) => {
    let i = 0
    while (i < bytes.length - 1 && bytes[i] === 0) i++
    let b = bytes.slice(i)
    if (b[0] & 0x80) b = concat(Uint8Array.of(0), b)
    return concat(Uint8Array.of(0x02, b.length), b)
  }
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32))
  return concat(Uint8Array.of(0x30, r.length + s.length), r, s)
}

class Jar {
  constructor() { this.cookies = new Map() }
  absorb(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim()
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim()))
      if (expired || value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
}

async function call(jar, path, { method = 'GET', body, bearer } = {}) {
  const r = await fetch(`${path.startsWith('http') ? '' : APP}${path}`, {
    method,
    headers: {
      origin: APP,
      ...(jar.cookies.size ? { cookie: jar.header() } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  })
  jar.absorb(r)
  const text = await r.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: r.status, data }
}

const expect = (cond, label, extra) => {
  if (!cond) { console.error(`FAIL  ${label}`, extra ?? ''); process.exit(1) }
  console.log(`ok    ${label}`)
}

// ── the software authenticator ───────────────────────────────────────────

class SoftKey {
  static async create() {
    const k = new SoftKey()
    k.pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
    k.credId = crypto.getRandomValues(new Uint8Array(32))
    k.counter = 0
    const jwk = await crypto.subtle.exportKey('jwk', k.pair.publicKey)
    k.cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, fromB64u(jwk.x)], [-3, fromB64u(jwk.y)]]))
    return k
  }
  async authData(flags, attested) {
    const rpIdHash = await sha256(enc.encode(RP_ID))
    const counter = new Uint8Array(4)
    new DataView(counter.buffer).setUint32(0, ++this.counter)
    const base = concat(rpIdHash, Uint8Array.of(flags), counter)
    if (!attested) return base
    const idLen = new Uint8Array(2)
    new DataView(idLen.buffer).setUint16(0, this.credId.length)
    return concat(base, new Uint8Array(16), idLen, this.credId, this.cose)
  }
  /** flags: UP 0x01, UV 0x04, AT 0x40 */
  async register(options, { uv }) {
    const clientData = enc.encode(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: APP, crossOrigin: false }))
    const authData = await this.authData(0x41 | (uv ? 0x04 : 0), true)
    const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
    }
  }
  async assert(options, { uv }) {
    const clientData = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: APP, crossOrigin: false }))
    const authData = await this.authData(0x01 | (uv ? 0x04 : 0), false)
    const toSign = concat(authData, await sha256(clientData))
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.pair.privateKey, toSign))
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: 'public-key',
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(derSignature(raw)) },
      clientExtensionResults: {},
    }
  }
}

// ── the loop ─────────────────────────────────────────────────────────────

const [, , cmd, email, code] = process.argv

if (cmd === 'send') {
  const r = await call(new Jar(), '/auth/email-otp/send-verification-otp', { method: 'POST', body: { email, type: 'sign-in' } })
  console.log(r.status, r.data)
  process.exit(r.status === 200 ? 0 : 1)
}

if (cmd !== 'run' || !email || !code) {
  console.error('usage: passkey-smoke.mjs send <email> | run <email> <code>')
  process.exit(2)
}

const owner = new Jar()
let r = await call(owner, '/auth/sign-in/email-otp', { method: 'POST', body: { email, otp: code } })
expect(r.status === 200 && owner.cookies.has('__Secure-better-auth.session_token'), 'code sign-in gives a session cookie', r)

const key = await SoftKey.create()

// 1. Refused without user verification.
r = await call(owner, '/auth/passkey/generate-register-options?name=Smoke%20test')
expect(r.status === 200 && r.data.rp?.id === RP_ID, `register options carry rpID ${RP_ID}`, r)
expect(r.data.authenticatorSelection?.userVerification === 'required', 'register options ask for user verification', r.data.authenticatorSelection)
r = await call(owner, '/auth/passkey/verify-registration', { method: 'POST', body: { response: await key.register(r.data, { uv: false }), name: 'Smoke test' } })
expect(r.status === 400 && r.data.code === 'USER_VERIFICATION_REQUIRED', 'registration without user verification is refused', r)

// 2. Stored with it.
r = await call(owner, '/auth/passkey/generate-register-options?name=Smoke%20test')
r = await call(owner, '/auth/passkey/verify-registration', { method: 'POST', body: { response: await key.register(r.data, { uv: true }), name: 'Smoke test' } })
expect(r.status === 200 && r.data.credentialID === b64u(key.credId), 'registration with user verification is stored', r)
const passkeyId = r.data.id
expect(r.data.name === 'Smoke test', 'the given name is kept', r.data.name)

r = await call(owner, '/auth/passkey/list-user-passkeys')
expect(r.status === 200 && r.data.some((p) => p.id === passkeyId), 'the list shows it', r)

// 3. An anonymous browser signs in with it.
const stranger = new Jar()
r = await call(stranger, '/auth/passkey/generate-authenticate-options')
expect(r.status === 200 && typeof r.data.challenge === 'string', 'anonymous authenticate options', r)
r = await call(stranger, '/auth/passkey/verify-authentication', { method: 'POST', body: { response: await key.assert(r.data, { uv: false }) } })
expect(r.status === 401 && r.data.code === 'USER_VERIFICATION_REQUIRED', 'assertion without user verification is refused', r)
expect(!stranger.cookies.has('__Secure-better-auth.session_token'), 'and no session was set', stranger.header())

r = await call(stranger, '/auth/passkey/generate-authenticate-options')
r = await call(stranger, '/auth/passkey/verify-authentication', { method: 'POST', body: { response: await key.assert(r.data, { uv: true }) } })
expect(r.status === 200 && r.data.user?.email === email, 'assertion with user verification signs in', r)
expect(stranger.cookies.has('__Secure-better-auth.session_token'), 'session cookie set for the passkey sign-in')

r = await call(stranger, '/auth/token')
expect(r.status === 200 && typeof r.data.token === 'string', 'a JWT is minted from the passkey session', r)
const payload = JSON.parse(Buffer.from(r.data.token.split('.')[1], 'base64url').toString())
expect(payload.iss === API, `issuer is ${API}`, payload.iss)
r = await call(new Jar(), `${API}/v1/core/me`, { bearer: r.data.token })
expect(r.status === 200, 'the API accepts it', r.status)

// A replayed counter must fail: the same assertion twice.
// (Not tested: simplewebauthn rejects counter <= stored only when both are non-zero.)

// 4. Rename, remove, list agrees.
r = await call(owner, '/auth/passkey/update-passkey', { method: 'POST', body: { id: passkeyId, name: 'Smoke test, renamed' } })
expect(r.status === 200 && r.data.passkey?.name === 'Smoke test, renamed', 'rename', r)
r = await call(stranger, '/auth/passkey/delete-passkey', { method: 'POST', body: { id: passkeyId } })
expect(r.status === 200, 'the passkey session may remove its own passkey', r)
r = await call(owner, '/auth/passkey/list-user-passkeys')
expect(r.status === 200 && r.data.length === 0, 'the list is empty again', r)

r = await call(stranger, '/auth/passkey/generate-authenticate-options')
r = await call(stranger, '/auth/passkey/verify-authentication', { method: 'POST', body: { response: await key.assert(r.data, { uv: true }) } })
expect(r.status === 401, 'a removed passkey cannot sign in', r)

await call(owner, '/auth/sign-out', { method: 'POST', body: {} })
await call(stranger, '/auth/sign-out', { method: 'POST', body: {} })
console.log('\nall good. Check the inbox for "A device was added" and "A device was removed".')
