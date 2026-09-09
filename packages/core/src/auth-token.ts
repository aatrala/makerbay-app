import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose'

/**
 * Verifying the platform's own access tokens (issue 157).
 *
 * Two issuers are live during the transition: Cognito, verified where it
 * always was with aws-jwt-verify, and Better Auth at `https://api.makerbay.app`,
 * verified here against its JWKS. Callers look at the issuer first and pick
 * the verifier; this file only knows about the second. Verification is
 * always on, whatever AUTH_PROVIDER says, so a dark deploy can be tested
 * end to end without touching production sign-in.
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

/** The unverified `iss` claim, or undefined for anything that is not a JWT. Never trust it for more than routing. */
export function issuerOf(token: string): string | undefined {
  try {
    return decodeJwt(token).iss
  } catch {
    return undefined
  }
}

/** True when this token claims to come from Better Auth and that issuer is configured. */
export function isPlatformJwt(token: string): boolean {
  const issuer = process.env.AUTH_ISSUER
  return Boolean(issuer) && issuerOf(token) === issuer
}

export async function verifyPlatformJwt(token: string): Promise<{ sub: string; email: string }> {
  const issuer = process.env.AUTH_ISSUER
  const url = process.env.AUTH_JWKS_URL
  if (!issuer || !url) throw new Error('auth_not_configured')
  jwks ??= createRemoteJWKSet(new URL(url))
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: process.env.AUTH_AUDIENCE ?? issuer,
  })
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('no_subject')
  return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : '' }
}
