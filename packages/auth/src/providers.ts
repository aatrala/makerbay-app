import type { GenericOAuthConfig } from 'better-auth/plugins'

/**
 * Upstream identity providers (issue 157): the seam that makes the IdP
 * swappable.
 *
 * Better Auth owns users and sessions. Anything listed here is just a way
 * to prove who you are, linked to a Better Auth user by provider id and
 * account id. Cognito is the first entry so today's users keep their
 * passwords without a password export; WorkOS, Google or any OIDC issuer
 * is another entry and an environment variable, nothing else.
 *
 * Cognito sends no email in this flow - the hosted page checks a password
 * and returns a code - so the SES sandbox has no bearing on it.
 */
export function upstreamProviders(): GenericOAuthConfig[] {
  const enabled = new Set((process.env.AUTH_UPSTREAMS ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  const out: GenericOAuthConfig[] = []

  if (enabled.has('cognito')) {
    const issuer = process.env.COGNITO_ISSUER
    const clientId = process.env.COGNITO_UPSTREAM_CLIENT_ID
    if (!issuer || !clientId) throw new Error('cognito upstream enabled but COGNITO_ISSUER / COGNITO_UPSTREAM_CLIENT_ID unset')
    out.push({
      providerId: 'cognito',
      name: 'MakerBay password',
      discoveryUrl: `${issuer}/.well-known/openid-configuration`,
      clientId,
      // A public client with PKCE: no client secret to store or rotate.
      tokenEndpointAuth: { method: 'none' },
      pkce: true,
      scopes: ['openid', 'email', 'profile'],
      requireEmailVerification: true,
      /*
       * Cognito's userinfo returns email_verified as the STRING "true". Left
       * as-is, Better Auth would read it as unverified and refuse to link the
       * account to the existing user with that email - which is the whole
       * point of this provider.
       */
      mapProfileToUser: (p) => ({
        email: typeof p.email === 'string' ? p.email : null,
        name: typeof p.name === 'string' ? p.name : typeof p.email === 'string' ? p.email : '',
        emailVerified: p.email_verified === true || p.email_verified === 'true',
      }),
    })
  }

  return out
}
