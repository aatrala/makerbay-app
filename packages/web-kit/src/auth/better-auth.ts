/**
 * The Better Auth client (issue 157, reshaped in issue 158 part B), over
 * plain fetch. The endpoints are a handful of JSON calls; the SPA has no
 * reason to bundle an auth SDK to make them.
 *
 * Two modes, decided once from where the page is running:
 *
 * - **First-party** (the real dashboard at app.makerbay.app): `/auth/*` is
 *   proxied to the API on the dashboard's own origin, so the SESSION lives
 *   in an HttpOnly cookie the browser sends by itself. Nothing a script
 *   can read holds the session. A small localStorage marker only remembers
 *   that a session probably exists, so the app can decide synchronously
 *   whether to show the sign-in page; the cookie is the truth.
 * - **Bearer** (a local dev server, or anything not on the dashboard
 *   origin): the API is cross-origin and its CORS allows every origin,
 *   which rules out cookies, so the session token travels as a bearer
 *   header from localStorage, as it did in phase 1.
 *
 * In both modes the ACCESS token - the 15-minute JWT the API authorizer
 * verifies - is held in memory only and re-minted from the session when it
 * is about to expire or on a 401.
 */
import { API_BASE } from '../config'

const FIRST_PARTY_HOST = 'app.makerbay.app'
const firstParty = (): boolean => typeof window !== 'undefined' && window.location.hostname === FIRST_PARTY_HOST
export const isFirstParty = firstParty
const authBase = (): string => (firstParty() ? `${window.location.origin}/auth` : `${API_BASE}/auth`)

const MARKER_KEY = 'mb.signedIn'
const SESSION_KEY = 'mb.sessionToken'

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

let accessJwt: string | undefined

export const isSignedIn = (): boolean =>
  firstParty() ? storage.get(MARKER_KEY) === '1' : Boolean(storage.get(SESSION_KEY))

export const rememberSession = (token?: string) => {
  if (firstParty()) storage.set(MARKER_KEY, '1')
  else if (token) storage.set(SESSION_KEY, token)
}

export function clear(): void {
  storage.del(MARKER_KEY)
  storage.del(SESSION_KEY)
  accessJwt = undefined
}

export async function authCall(path: string, body?: unknown, method = 'POST'): Promise<any> {
  const session = firstParty() ? null : storage.get(SESSION_KEY)
  const r = await fetch(`${authBase()}${path}`, {
    method,
    credentials: firstParty() ? 'include' : 'omit',
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
  // In bearer mode the plugin also returns the session token as a header.
  const issued = r.headers.get('set-auth-token')
  if (issued && !firstParty()) storage.set(SESSION_KEY, issued)
  return data
}

/** Step one of the code sign-in. Works for a new address too: the account is created when the code is used. */
export async function sendCode(email: string): Promise<void> {
  await authCall('/email-otp/send-verification-otp', { email: email.trim().toLowerCase(), type: 'sign-in' })
}

/** Step two. Remembers the session and mints the first access token. */
export async function signInWithCode(email: string, otp: string): Promise<void> {
  const data = await authCall('/sign-in/email-otp', { email: email.trim().toLowerCase(), otp: otp.trim() })
  rememberSession(typeof data.token === 'string' ? data.token : undefined)
  if (!isSignedIn()) throw new AuthError(500, 'no_session', 'Signed in, but no session was returned.')
  await mintAccessToken()
}

/**
 * The upstream sign-in ("sign in with your MakerBay password"). The server
 * answers with the provider's page to go to; the provider sends the
 * browser back to the auth callback, which sets the session cookie on this
 * origin and redirects to the dashboard root. `finishExternalSignIn` then
 * notices the session on the next load.
 */
export async function startUpstreamSignIn(provider = 'cognito'): Promise<void> {
  if (!firstParty()) throw new AuthError(400, 'first_party_only', 'Password sign-in works on app.makerbay.app.')
  const data = await authCall('/sign-in/social', {
    provider,
    callbackURL: `${window.location.origin}/`,
    errorCallbackURL: `${window.location.origin}/?auth_error=upstream`,
  })
  if (typeof data.url !== 'string') throw new AuthError(500, 'no_redirect', 'The sign-in provider gave no address to go to.')
  window.location.href = data.url
}

/**
 * On load: if this browser is not marked as signed in but holds a session
 * cookie (the way back from an upstream sign-in, or a cleared marker), pick
 * the session up. One small same-origin request; nothing for a browser
 * that has never signed in beyond a fast null.
 */
export async function finishExternalSignIn(): Promise<boolean> {
  if (!firstParty() || isSignedIn()) return false
  try {
    const session = await authCall('/get-session', undefined, 'GET')
    if (!session || !session.user) return false
    rememberSession()
    await mintAccessToken()
    return true
  } catch {
    return false
  }
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
  const data = await authCall('/token', undefined, 'GET')
  if (typeof data.token !== 'string') throw new AuthError(401, 'unauthorized')
  accessJwt = data.token
  return data.token
}

/** The bearer for API calls: the in-memory JWT while it has a minute left, else a fresh one. */
export async function accessToken(force = false): Promise<string> {
  if (!isSignedIn()) return ''
  if (!force && accessJwt && expiryOf(accessJwt) > Date.now() + 60_000) return accessJwt
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
    if (isSignedIn()) await authCall('/sign-out', {})
  } catch {
    // Signing out of a session that is already gone is still signed out.
  }
  clear()
}
