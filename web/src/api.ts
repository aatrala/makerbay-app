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
  constructor(public status: number, public code: string) {
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
  if (!r.ok) throw new ApiError(r.status, data.error ?? `http_${r.status}`)
  return data
}

// ── Typed helpers ────────────────────────────────────────────────────────

export interface Me {
  user: { userId: string; email?: string; role?: string }
  tenant: { tenantId: string; name: string; slug: string; plan: string } | null
  entitlements?: { modules: Record<string, { enabled: boolean; plan: string; limits: Record<string, number> }> }
}

export const getMe = (): Promise<Me> => api('GET', '/v1/core/me')
export const CHAT_BASE = 'https://chat.makerbay.app'
export const WIDGET_BASE = 'https://widget.makerbay.app'
export const createTenant = (name: string) => api('POST', '/v1/core/tenants', { name })
export const enableModule = (id: string) => api('POST', `/v1/core/modules/${id}/enable`, {})
