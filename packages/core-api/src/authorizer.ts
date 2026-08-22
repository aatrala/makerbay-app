import { CognitoJwtVerifier } from 'aws-jwt-verify'
import { findApiKeyByHash, getEntitlements, getUser, hashApiKey } from '@makerbay/core'

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

    const payload = await verifier.verify(token)
    const user = await getUser(payload.sub)
    const tenantId = user?.tenantId ?? ''
    const entitlements = tenantId ? await getEntitlements(tenantId) : { modules: {} }
    return {
      isAuthorized: true,
      context: {
        userId: payload.sub,
        email: String(payload.email ?? ''),
        tenantId,
        scopes: '*',
        entitlements: JSON.stringify(entitlements),
      },
    }
  } catch {
    return { isAuthorized: false }
  }
}
