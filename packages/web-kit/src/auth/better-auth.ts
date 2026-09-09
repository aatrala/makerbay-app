/**
 * The Better Auth client (issue 157), over plain fetch.
 *
 * Same choice the Cognito client made: the endpoints are a handful of JSON
 * calls, and the SPA has no reason to bundle an auth SDK to make them. Two
 * tokens live here:
 *
 * - the SESSION token, sent as a bearer to /auth/* so the API can find the
 *   session (the `bearer` plugin), seven days, refreshed by the server;
 * - the ACCESS token, a 15-minute JWT minted from the session and sent to
 *   everything else, where the Lambda authorizer verifies it against
 *   /auth/jwks. It is re-minted a minute before it expires, or on a 401.
 *
 * Nothing is in a cookie: app. and api. are different origins and the API's
 * CORS allows every origin, which rules credentials out.
 */
import { API_BASE } from '../config'

const AUTH_BASE = `${API_BASE}/auth`
const SESSION_KEY = 'mb.sessionToken'
const ACCESS_KEY = 'mb.accessToken'

export class AuthError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code)
  }
}

const storage = {
  get(k: string) { try { return localStorage.getItem(k) } catch { return null } },
  set(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
  del(k: string) { try { localStorage.removeItem(k) } catch { /* private mode */ } },
}

export const isSignedIn = (): boolean => Boolean(storage.get(SESSION_KEY))

export function clear(): void {
  storage.del(SESSION_KEY)
  storage.del(ACCESS_KEY)
}

async function call(path: string, body?: unknown, method = 'POST'): Promise<any> {
  const session = storage.get(SESSION_KEY)
  const r = await fetch(`${AUTH_BASE}${path}`, {
    method,
    headers: {
      ...(session ? { authorization: `Bearer ${session}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const code = typeof data.code === 'string' ? data.code : `http_${r.status}`
    throw new AuthError(r.status, code, typeof data.message === 'string' ? data.message : undefined)
  }
  // The bearer plugin also returns the session token as a header on sign-in.
  const issued = r.headers.get('set-auth-token')
  if (issued) storage.set(SESSION_KEY, issued)
  return data
}

/** Step one of the code sign-in. Works for a new address too: the account is created when the code is used. */
export async function sendCode(email: string): Promise<void> {
  await call('/email-otp/send-verification-otp', { email: email.trim().toLowerCase(), type: 'sign-in' })
}

/** Step two. Stores the session and mints the first access token. */
export async function signInWithCode(email: string, otp: string): Promise<void> {
  const data = await call('/sign-in/email-otp', { email: email.trim().toLowerCase(), otp: otp.trim() })
  if (typeof data.token === 'string') storage.set(SESSION_KEY, data.token)
  if (!storage.get(SESSION_KEY)) throw new AuthError(500, 'no_session', 'Signed in, but no session was returned.')
  await mintAccessToken()
}

/**
 * Step one of the upstream sign-in. The server answers with the provider's
 * page to go to; on the way back the bridge hands the SPA a one-time token
 * in the URL fragment, which `finishExternalSignIn` consumes.
 */
export async function startUpstreamSignIn(provider = 'cognito'): Promise<void> {
  const data = await call('/sign-in/social', {
    provider,
    callbackURL: `${API_BASE}/auth-bridge`,
    errorCallbackURL: `${window.location.origin}/#auth_error=upstream`,
  })
  if (typeof data.url !== 'string') throw new AuthError(500, 'no_redirect', 'The sign-in provider gave no address to go to.')
  window.location.href = data.url
}

/** True when a one-time token was found in the URL and exchanged for a session. */
export async function finishExternalSignIn(): Promise<boolean> {
  const hash = window.location.hash
  const m = /[#&]ott=([^&]+)/.exec(hash)
  if (!m) return false
  // Strip it before anything can log or bookmark it.
  history.replaceState(null, '', window.location.pathname + window.location.search)
  const data = await call('/one-time-token/verify', { token: decodeURIComponent(m[1]) })
  const token = data?.session?.token
  if (typeof token !== 'string') throw new AuthError(500, 'no_session', 'The sign-in could not be completed.')
  storage.set(SESSION_KEY, token)
  await mintAccessToken()
  return true
}

function expiryOf(jwt: string): number {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

export async function mintAccessToken(): Promise<string> {
  const data = await call('/token', undefined, 'GET')
  if (typeof data.token !== 'string') throw new AuthError(401, 'unauthorized')
  storage.set(ACCESS_KEY, data.token)
  return data.token
}

/** The bearer for API calls: the cached JWT while it has a minute left, else a fresh one. */
export async function accessToken(force = false): Promise<string> {
  if (!isSignedIn()) return ''
  const cached = storage.get(ACCESS_KEY)
  if (!force && cached && expiryOf(cached) > Date.now() + 60_000) return cached
  try {
    return await mintAccessToken()
  } catch (err) {
    if (err instanceof AuthError && (err.status === 401 || err.status === 403)) {
      // The session is gone: expired, revoked, or the row was deleted.
      clear()
      return ''
    }
    throw err
  }
}

export async function signOut(): Promise<void> {
  try {
    if (isSignedIn()) await call('/sign-out', {})
  } catch {
    // Signing out of a session that is already gone is still signed out.
  }
  clear()
}
