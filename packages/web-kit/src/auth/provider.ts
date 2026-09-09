/**
 * Which sign-in the dashboard uses (issue 157, docs/spec-auth.md).
 *
 * Mirrors `AUTH_PROVIDER` in the CDK stack. The default is a constant so the
 * cutover is one edit here and one there; `?auth=better-auth` on the URL
 * overrides it for this browser and sticks, which is how the dark path is
 * tested on the live dashboard before anything flips for everyone.
 */
export type AuthProvider = 'cognito' | 'better-auth'

export const DEFAULT_AUTH_PROVIDER: AuthProvider = 'better-auth'

const KEY = 'mb.authProvider'

export function authProvider(): AuthProvider {
  if (typeof window === 'undefined') return DEFAULT_AUTH_PROVIDER
  try {
    const q = new URLSearchParams(window.location.search).get('auth')
    if (q === 'better-auth' || q === 'cognito') localStorage.setItem(KEY, q)
    const stored = localStorage.getItem(KEY)
    if (stored === 'better-auth' || stored === 'cognito') return stored
  } catch {
    // Storage unavailable: private mode, or a browser set to block it.
  }
  return DEFAULT_AUTH_PROVIDER
}
