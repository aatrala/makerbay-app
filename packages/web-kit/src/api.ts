// API + auth client. Cognito is called directly over its JSON protocol —
// no SDK needed for USER_PASSWORD_AUTH flows, which keeps the bundle tiny.

export const API_BASE = 'https://api.makerbay.app'
const COGNITO_URL = 'https://cognito-idp.us-east-1.amazonaws.com/'
const CLIENT_ID = '3267h4gvj28r6ahaui5evn6dl4'

// ── Token storage ────────────────────────────────────────────────────────

const store = {
  get idToken() { return localStorage.getItem('mb.idToken') },
  get refreshToken() { return localStorage.getItem('mb.refreshToken') },
  set(tokens: { idToken?: string; refreshToken?: string }) {
    if (tokens.idToken) localStorage.setItem('mb.idToken', tokens.idToken)
    if (tokens.refreshToken) localStorage.setItem('mb.refreshToken', tokens.refreshToken)
  },
  clear() {
    localStorage.removeItem('mb.idToken')
    localStorage.removeItem('mb.refreshToken')
  },
}

export const isLoggedIn = () => Boolean(store.idToken)
export const logout = () => { store.clear(); window.location.href = '/' }

// ── Cognito ──────────────────────────────────────────────────────────────

async function cognito(target: string, body: unknown): Promise<any> {
  const r = await fetch(COGNITO_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  })
  const data = await r.json()
  if (!r.ok) throw new Error(data.message ?? data.__type ?? 'auth_error')
  return data
}

export async function signUp(email: string, password: string): Promise<void> {
  await cognito('SignUp', {
    ClientId: CLIENT_ID,
    Username: email,
    Password: password,
    UserAttributes: [{ Name: 'email', Value: email }],
  })
}

export async function confirmSignUp(email: string, code: string): Promise<void> {
  await cognito('ConfirmSignUp', { ClientId: CLIENT_ID, Username: email, ConfirmationCode: code })
}

export async function login(email: string, password: string): Promise<void> {
  const r = await cognito('InitiateAuth', {
    ClientId: CLIENT_ID,
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  })
  store.set({
    idToken: r.AuthenticationResult.IdToken,
    refreshToken: r.AuthenticationResult.RefreshToken,
  })
}

async function refreshSession(): Promise<boolean> {
  const refreshToken = store.refreshToken
  if (!refreshToken) return false
  try {
    const r = await cognito('InitiateAuth', {
      ClientId: CLIENT_ID,
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    })
    store.set({ idToken: r.AuthenticationResult.IdToken })
    return true
  } catch {
    return false
  }
}

// ── API ──────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(public status: number, public code: string, public detail?: string) {
    super(code)
  }
}

export async function api(method: string, path: string, body?: unknown, retried = false): Promise<any> {
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${store.idToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if ((r.status === 401 || r.status === 403) && !retried && (await refreshSession())) {
    return api(method, path, body, true)
  }
  if (r.status === 401) { logout(); throw new ApiError(401, 'unauthorized') }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    throw new ApiError(
      r.status,
      data.error ?? `http_${r.status}`,
      typeof data.message === 'string' && data.message ? data.message : undefined,
    )
  }
  return data
}

// ── Typed helpers ────────────────────────────────────────────────────────

export interface Me {
  user: { userId: string; email?: string; role?: string }
  tenant: { tenantId: string; name: string; slug: string; plan: string } | null
  entitlements?: { modules: Record<string, { enabled: boolean; plan: string; limits: Record<string, number> }> }
}

export const getMe = (): Promise<Me> => api('GET', '/v1/core/me')
export const getBillingSummary = () => api('GET', '/v1/core/billing/summary')
export const resetBilling = (force = false) => api('POST', '/v1/core/billing/reset', { force })
export const STREAM_BASE = 'https://stream.makerbay.app'

/**
 * Streaming chat. Yields text deltas as they arrive and resolves with the
 * final metadata. Callers fall back to the plain route if this rejects.
 */
export async function streamChat(
  body: { sessionId?: string; message: string },
  onDelta: (text: string) => void,
): Promise<{ sessionId: string; messageId: string; citations?: Array<{ sourceId: string; name: string }>; fallback?: boolean }> {
  const r = await fetch(STREAM_BASE, {
    method: 'POST',
    headers: { authorization: `Bearer ${store.idToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok || !r.body) throw new ApiError(r.status, 'no_stream')

  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let meta: any = {}

  const handle = (line: string) => {
    if (!line.trim()) return
    let evt: any
    try { evt = JSON.parse(line) } catch { return }
    if (evt.type === 'delta') onDelta(evt.text)
    else if (evt.type === 'meta') meta = { ...meta, ...evt }
    else if (evt.type === 'done') meta = { ...meta, ...evt }
    else if (evt.type === 'error') throw new ApiError(200, evt.error)
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) { if (buf.trim()) handle(buf); break }
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    lines.forEach(handle)
  }
  return meta
}

export const CHAT_BASE = 'https://chat.makerbay.app'
export const WIDGET_BASE = 'https://widget.makerbay.app'
export const createTenant = (name: string) => api('POST', '/v1/core/tenants', { name })
export const enableModule = (id: string) => api('POST', `/v1/core/modules/${id}/enable`, {})

// ── Human error messages ─────────────────────────────────────────────────
// The API returns machine codes. Screens must never show those raw: each one
// gets a sentence that says what happened and, where possible, what to do.

const MESSAGES: Record<string, string> = {
  limit_exceeded: "You've used every message included in this plan for the month. Upgrade under Billing to keep going.",
  source_limit_exceeded: 'This plan has room for a limited number of knowledge sources. Remove one, or upgrade under Billing.',
  source_limit_reached: 'This plan has room for a limited number of knowledge sources. Remove one, or upgrade under Billing.',
  upgrade_required: 'This is a paid feature — upgrade under Billing to use it.',
  module_not_enabled: 'This module is not switched on for your workspace.',
  forbidden: "You don't have permission to do that. Ask the workspace owner.",
  unauthorized: 'Your session expired. Sign in again.',
  not_found: "We couldn't find that — it may have been removed.",
  invalid_url: "That doesn't look like a web address we can reach. Use a full https:// link to a public page.",
  blocked_host: "We can't fetch that address. Only public websites can be added.",
  robots_disallowed: "That site's robots.txt asks us not to read this page.",
  fetch_failed: "We couldn't reach that page. Check the address, or try again in a minute.",
  too_short: 'That page returned almost no text — it probably builds its content with JavaScript. Paste the text instead.',
  unsupported_type: "We can't read that file type yet. Try PDF, Word, Markdown, HTML, text or CSV.",
  too_large: 'That file is larger than we can process. Split it into smaller documents.',
  upload_failed: 'The upload did not finish. Check your connection and try again.',
  billing_not_configured: 'Billing is not set up for this workspace yet.',
  rate_limited: "That's a lot of requests at once — wait a moment and try again.",
}

/** Turn any thrown value into a sentence worth showing a customer. */
export function explain(err: unknown, fallback = 'Something went wrong. Try again, and tell us if it keeps happening.'): string {
  const code = err instanceof ApiError ? err.code : err instanceof Error ? err.message : ''
  if (MESSAGES[code]) return MESSAGES[code]
  if (err instanceof ApiError && err.status >= 500) return 'Our side had a problem with that. Try again in a moment.'
  // The server took the trouble to write a human sentence - show it.
  if (err instanceof ApiError && err.detail) return err.detail
  // An unmapped code is still better than nothing, but never show a bare slug.
  return code && !/^(http_\d+|[a-z_]+)$/.test(code) ? code : fallback
}
