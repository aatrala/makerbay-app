/**
 * Passkeys from the browser's side (issue 158 part B1): "sign in with your
 * fingerprint". The ceremony itself is @simplewebauthn/browser; the four
 * server calls go through the same auth client as the code sign-in.
 *
 * First-party only. The plugin binds each ceremony to a signed challenge
 * cookie, and only the dashboard origin (where /auth is proxied) can hold
 * one, so a local dev build sees no passkey buttons at all rather than
 * buttons that fail.
 */
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from '@simplewebauthn/browser'
import { AuthError, authCall, isFirstParty, mintAccessToken, rememberSession } from './better-auth'

export interface Passkey {
  id: string
  name?: string
  deviceType: 'singleDevice' | 'multiDevice'
  backedUp: boolean
  createdAt: string
  aaguid?: string
}

/** Whether this page can do passkeys at all. Synchronous; the platform check is separate. */
export const passkeysPossible = (): boolean => isFirstParty() && browserSupportsWebAuthn()

/** Whether this device has a fingerprint, face or PIN authenticator built in. */
export async function hasPlatformAuthenticator(): Promise<boolean> {
  if (!passkeysPossible()) return false
  try { return await platformAuthenticatorIsAvailable() } catch { return false }
}

export async function passkeyAutofillPossible(): Promise<boolean> {
  if (!passkeysPossible()) return false
  try { return await browserSupportsWebAuthnAutofill() } catch { return false }
}

/**
 * The sign-in. With `autofill`, the request waits in the background for the
 * browser to offer a saved passkey on the email field; without it the
 * browser prompts immediately. Either way a success is a session exactly as
 * a code gives.
 */
export async function signInWithPasskey(opts: { autofill?: boolean } = {}): Promise<void> {
  const options = await authCall('/passkey/generate-authenticate-options', undefined, 'GET')
  let assertion
  try {
    assertion = await startAuthentication({
      // The server asks for "preferred" and then refuses an unverified
      // assertion; asking for "required" here means the prompt says so.
      optionsJSON: { ...options, userVerification: 'required' },
      useBrowserAutofill: opts.autofill === true,
    })
  } catch (err) {
    throw ceremonyError(err)
  }
  const { clientExtensionResults: _ignored, ...response } = assertion
  const data = await authCall('/passkey/verify-authentication', { response })
  rememberSession(typeof data.token === 'string' ? data.token : undefined)
  await mintAccessToken()
}

/** Register this device. Needs a session under an hour old; the server says so if not. */
export async function addPasskey(name?: string): Promise<Passkey> {
  const q = name ? `?name=${encodeURIComponent(name)}` : ''
  const options = await authCall(`/passkey/generate-register-options${q}`, undefined, 'GET')
  let attestation
  try {
    attestation = await startRegistration({ optionsJSON: options })
  } catch (err) {
    throw ceremonyError(err)
  }
  const { clientExtensionResults: _ignored, ...response } = attestation
  return authCall('/passkey/verify-registration', { response, ...(name ? { name } : {}) })
}

export const listPasskeys = (): Promise<Passkey[]> => authCall('/passkey/list-user-passkeys', undefined, 'GET')

export async function renamePasskey(id: string, name: string): Promise<void> {
  await authCall('/passkey/update-passkey', { id, name })
}

export async function removePasskey(id: string): Promise<void> {
  await authCall('/passkey/delete-passkey', { id })
}

function ceremonyError(err: unknown): AuthError {
  if (err instanceof WebAuthnError) {
    if (err.code === 'ERROR_CEREMONY_ABORTED' || err.name === 'NotAllowedError') {
      return new AuthError(400, 'PASSKEY_CANCELLED', 'Nothing was saved. You can try again any time.')
    }
    if (err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
      return new AuthError(400, 'PASSKEY_EXISTS', 'This device is already set up to sign in.')
    }
    return new AuthError(400, err.code, err.message)
  }
  return new AuthError(400, 'PASSKEY_FAILED', err instanceof Error ? err.message : 'The device did not respond.')
}

/**
 * The offer after a code sign-in: "sign in with your fingerprint next
 * time". Declining is remembered per browser, and the offer comes back
 * after the THIRD code sign-in since then - "you keep doing the slow thing"
 * is the trigger, not a calendar (the product review).
 */
const DECLINED = 'mb.pk.declined'
const CODE_SIGNINS = 'mb.pk.codeSignIns'
const OFFER_NOW = 'mb.pk.offer'
export const OFFER_AFTER = 3

const local = {
  get(k: string) { try { return localStorage.getItem(k) } catch { return null } },
  set(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
  del(k: string) { try { localStorage.removeItem(k) } catch { /* private mode */ } },
}
const session = {
  get(k: string) { try { return sessionStorage.getItem(k) } catch { return null } },
  set(k: string, v: string) { try { sessionStorage.setItem(k, v) } catch { /* private mode */ } },
  del(k: string) { try { sessionStorage.removeItem(k) } catch { /* private mode */ } },
}

/** Call once a code sign-in has succeeded. */
export function noteCodeSignIn(): void {
  const n = Number(local.get(CODE_SIGNINS) ?? '0') + 1
  local.set(CODE_SIGNINS, String(n))
  if (offerDue({ declined: local.get(DECLINED) === '1', codeSignIns: n })) session.set(OFFER_NOW, '1')
}

/** Pure: whether to show the card, from what the browser remembers. */
export const offerDue = (s: { declined: boolean; codeSignIns: number }): boolean =>
  !s.declined || s.codeSignIns >= OFFER_AFTER

/** Whether this visit should show the card (the sign-in just happened, and the browser did not say no recently). */
export const passkeyOfferPending = (): boolean => session.get(OFFER_NOW) === '1' && passkeysPossible()

export function declinePasskeyOffer(): void {
  local.set(DECLINED, '1')
  local.set(CODE_SIGNINS, '0')
  session.del(OFFER_NOW)
}

/** After a passkey is saved, or when the account already has one: the card is done. */
export function settlePasskeyOffer(): void {
  local.del(DECLINED)
  local.set(CODE_SIGNINS, '0')
  session.del(OFFER_NOW)
}

/** A friendly default for the device name, from what the browser says it is. */
export function thisDeviceName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad|Macintosh.*Mobile/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android phone'
  if (/Windows/.test(ua)) return 'Windows PC'
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac'
  if (/CrOS/.test(ua)) return 'Chromebook'
  return 'This device'
}
