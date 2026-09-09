import { CognitoJwtVerifier } from 'aws-jwt-verify'
import {
  findApiKeyByHash, getEntitlements, getTenant, getUser, hashApiKey, isPlatformJwt, verifyPlatformJwt,
} from '@makerbay/core'

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: 'id',
  clientId: process.env.USER_POOL_CLIENT_ID!,
})

interface SimpleAuthResult {
  isAuthorized: boolean
  context?: Record<string, string>
}

// HTTP API Lambda authorizer (simple responses). Resolves the caller to a
// tenant context. Results are cached on the Authorization header, so
// identity-sensitive routes in core-api re-read the Users table themselves.
export const handler = async (event: {
  headers?: Record<string, string | undefined>
}): Promise<SimpleAuthResult> => {
  const raw = event.headers?.authorization ?? event.headers?.Authorization ?? ''
  const token = raw.replace(/^Bearer\s+/i, '').trim()
  if (!token) return { isAuthorized: false }

  try {
    if (token.startsWith('mb_sk_') || token.startsWith('mb_pk_')) {
      const key = await findApiKeyByHash(hashApiKey(token))
      if (!key) return { isAuthorized: false }
      if (await suspended(key.tenantId)) return { isAuthorized: false }
      const entitlements = await getEntitlements(key.tenantId)
      return {
        isAuthorized: true,
        context: {
          tenantId: key.tenantId,
          keyId: key.keyId,
          scopes: key.scopes.join(','),
          entitlements: JSON.stringify(entitlements),
        },
      }
    }

    /*
     * Two issuers during the transition (issue 157). A Better Auth token is
     * verified against its JWKS; anything else is a Cognito ID token as
     * before. Both end in the same context, keyed by the same userId - the
     * migration wrote Better Auth users with their Cognito sub as the id -
     * so every route downstream is unchanged.
     */
    const { sub, email } = isPlatformJwt(token)
      ? await verifyPlatformJwt(token)
      : await verifier.verify(token).then((p) => ({ sub: p.sub, email: String(p.email ?? '') }))
    const user = await getUser(sub)
    const tenantId = user?.tenantId ?? ''
    if (tenantId && (await suspended(tenantId))) return { isAuthorized: false }
    const entitlements = tenantId ? await getEntitlements(tenantId) : { modules: {} }
    return {
      isAuthorized: true,
      context: {
        userId: sub,
        email,
        tenantId,
        scopes: '*',
        entitlements: JSON.stringify(entitlements),
      },
    }
  } catch {
    return { isAuthorized: false }
  }
}

// The kill switch's second half: getTenantBySlug hides public pages, and this
// denial covers everything authenticated. Authorizer results are cached per
// header, so a suspension can take up to the cache TTL to bite - the runbook
// says so.
async function suspended(tenantId: string): Promise<boolean> {
  return (await getTenant(tenantId))?.status === 'suspended'
}
