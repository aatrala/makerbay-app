import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { getAuth } from './auth'
import { toRequest, toResult } from './lambda'

/**
 * The auth Lambda (issue 157): Better Auth behind API Gateway, reached on
 * the dashboard's own origin through CloudFront (`app.makerbay.app/auth/*`)
 * so its cookies are first-party, and on `api.makerbay.app/auth/*` for
 * server-side callers such as the canary and the authorizer's JWKS fetch.
 *
 * There used to be an `/auth-bridge` here that turned a same-site cookie
 * into a bearer token after an upstream sign-in. With cookies first-party
 * the redirect back from Cognito lands on the dashboard already signed in,
 * so it went (issue 158 part B).
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const auth = await getAuth()
  const res = await auth.handler(toRequest(event))
  return toResult(res)
}
