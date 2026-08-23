import { CognitoJwtVerifier } from 'aws-jwt-verify'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from '@makerbay/core'

/**
 * Staff authorizer. Deliberately separate from the customer authorizer and
 * bound to a different Cognito pool: a customer token fails signature-level
 * validation here because the issuer and audience are wrong, rather than
 * relying on a claims check somebody could forget to add to a new route.
 */
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.STAFF_POOL_ID!,
  tokenUse: 'id',
  clientId: process.env.STAFF_CLIENT_ID!,
})

export const handler = async (event: {
  headers?: Record<string, string | undefined>
}): Promise<{ isAuthorized: boolean; context?: Record<string, string> }> => {
  const raw = event.headers?.authorization ?? event.headers?.Authorization ?? ''
  const token = raw.replace(/^Bearer\s+/i, '').trim()
  if (!token) return { isAuthorized: false }

  try {
    const payload = await verifier.verify(token)

    // The directory is the live source of truth for role and status, so
    // disabling a staff member takes effect within the authorizer cache
    // window rather than whenever their token happens to expire.
    const r = await ddb.send(
      new GetCommand({ TableName: process.env.TABLE_STAFF!, Key: { staffSub: payload.sub } }),
    )
    const staff = r.Item
    if (!staff || staff.status !== 'active') return { isAuthorized: false }

    return {
      isAuthorized: true,
      context: {
        staffSub: payload.sub,
        staffEmail: String(payload.email ?? staff.email ?? ''),
        staffRole: String(staff.role ?? 'support'),
      },
    }
  } catch {
    return { isAuthorized: false }
  }
}
