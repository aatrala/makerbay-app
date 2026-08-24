// Staff API client. A separate Cognito pool from customers, with TOTP MFA
// required and no self-signup, so a customer token can never reach these
// routes even if it were somehow presented.

export const ADMIN_API = 'https://admin-api.makerbay.app'
const COGNITO_URL = 'https://cognito-idp.us-east-1.amazonaws.com/'
const CLIENT_ID = '332kcmbddf6dkkdvefcgmcdbhg'

const store = {
  get idToken() { return sessionStorage.getItem('mb.staff.idToken') },
  set(idToken: string) { sessionStorage.setItem('mb.staff.idToken', idToken) },
  clear() { sessionStorage.removeItem('mb.staff.idToken') },
}

// Session storage, not local: a staff session should not outlive the tab.
export const isSignedIn = () => Boolean(store.idToken)
export const signOut = () => { store.clear(); window.location.href = '/' }

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

export interface AuthStep {
  done: boolean
  challenge?: 'SOFTWARE_TOKEN_MFA' | 'MFA_SETUP' | 'NEW_PASSWORD_REQUIRED'
  session?: string
  /** otpauth:// URI to show as a QR code during first-time MFA setup. */
  secretCode?: string
}

function apply(r: any): AuthStep {
  if (r.AuthenticationResult?.IdToken) {
    store.set(r.AuthenticationResult.IdToken)
    return { done: true }
  }
  return { done: false, challenge: r.ChallengeName, session: r.Session }
}

export async function startSignIn(email: string, password: string): Promise<AuthStep> {
  const r = await cognito('InitiateAuth', {
    ClientId: CLIENT_ID,
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  })
  const step = apply(r)
  // First sign-in: the pool requires MFA but none is registered yet.
  if (step.challenge === 'MFA_SETUP') {
    const assoc = await cognito('AssociateSoftwareToken', { Session: r.Session })
    return {
      done: false,
      challenge: 'MFA_SETUP',
      session: assoc.Session,
      secretCode: assoc.SecretCode,
    }
  }
  return step
}

/** Human wording for the auth errors a staff member can actually hit. */
export const explainAuth = (err: unknown): string => {
  const m = err instanceof Error ? err.message : ''
  if (/Incorrect username or password/i.test(m)) return 'That email and password do not match.'
  if (/Temporary password has expired/i.test(m)) {
    return 'Your temporary password expired. Ask for a new one to be issued in the Cognito console.'
  }
  if (/password.*policy|PasswordPolicy|InvalidPassword/i.test(m)) return PASSWORD_RULES.describe
  if (/Invalid session|NotAuthorized/i.test(m)) return 'That sign-in attempt timed out. Start again.'
  if (/Invalid code|CodeMismatch/i.test(m)) return 'That code was not accepted. Wait for the next one and retry.'
  return m || 'Sign-in failed.'
}

/**
 * First sign-in on a newly created staff account. Cognito issues a temporary
 * password and refuses to authenticate until it is replaced, so without this
 * branch a new account can never get in.
 */
export async function setNewPassword(
  email: string,
  session: string,
  newPassword: string,
): Promise<AuthStep> {
  const r = await cognito('RespondToAuthChallenge', {
    ClientId: CLIENT_ID,
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    Session: session,
    ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
  })
  const step = apply(r)
  // Setting the password usually lands straight on MFA enrolment.
  if (step.challenge === 'MFA_SETUP') {
    const assoc = await cognito('AssociateSoftwareToken', { Session: r.Session })
    return { done: false, challenge: 'MFA_SETUP', session: assoc.Session, secretCode: assoc.SecretCode }
  }
  return step
}

export const PASSWORD_RULES = {
  minLength: 14,
  describe: 'At least 14 characters, with an uppercase letter, a lowercase letter, a number and a symbol.',
}

/** Mirrors the pool policy so the failure is caught before the round trip. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < PASSWORD_RULES.minLength) return `Use at least ${PASSWORD_RULES.minLength} characters.`
  if (!/[A-Z]/.test(pw)) return 'Add an uppercase letter.'
  if (!/[a-z]/.test(pw)) return 'Add a lowercase letter.'
  if (!/[0-9]/.test(pw)) return 'Add a number.'
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Add a symbol.'
  return null
}

export async function submitMfa(email: string, session: string, code: string): Promise<AuthStep> {
  const r = await cognito('RespondToAuthChallenge', {
    ClientId: CLIENT_ID,
    ChallengeName: 'SOFTWARE_TOKEN_MFA',
    Session: session,
    ChallengeResponses: { USERNAME: email, SOFTWARE_TOKEN_MFA_CODE: code },
  })
  return apply(r)
}

/** Completes first-time authenticator enrolment, then signs in again. */
export async function completeMfaSetup(
  email: string,
  password: string,
  session: string,
  code: string,
): Promise<AuthStep> {
  const v = await cognito('VerifySoftwareToken', { Session: session, UserCode: code })
  if (v.Status !== 'SUCCESS') throw new Error('That code was not accepted. Try the next one.')
  return startSignIn(email, password)
}

export class AdminError extends Error {
  constructor(public status: number, public code: string, public detail?: string) {
    super(detail ?? code)
  }
}

export async function adminApi(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${ADMIN_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${store.idToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (r.status === 401) { signOut(); throw new AdminError(401, 'unauthorized') }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new AdminError(r.status, data.error ?? `http_${r.status}`, data.message)
  return data
}

const MESSAGES: Record<string, string> = {
  reason_required: 'Give a reason of at least 10 characters. It goes in the audit log with your name on it.',
  unknown_module: 'That module id does not exist.',
  unknown_plan_tier: 'That plan tier does not exist.',
  tenant_not_found: 'No workspace with that id.',
  grant_key_required: 'Pick a grant to revoke.',
  stripe_grant_immutable: 'Stripe grants cannot be revoked here. Cancel the subscription in Stripe instead.',
  forbidden: 'Your staff account is not allowed to do that.',
  unauthorized: 'Your session expired. Sign in again.',
}

export const explainAdmin = (err: unknown): string => {
  if (err instanceof AdminError) return err.detail ?? MESSAGES[err.code] ?? err.code
  return err instanceof Error ? err.message : 'Something went wrong.'
}

export interface TenantSummary {
  tenantId: string
  name: string
  slug: string
  plan: string
  status: string
  subscriptionStatus: string
  createdAt: string
}
