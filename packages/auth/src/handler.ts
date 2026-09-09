import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { getAuth } from './auth'
import { toRequest, toResult } from './lambda'

/**
 * The auth Lambda (issue 157). Two routes:
 *
 * - `/auth/*`: Better Auth itself, unchanged.
 * - `/auth-bridge`: the one MakerBay-specific step. After an upstream
 *   sign-in (Cognito today) the browser comes back to api.makerbay.app with
 *   a session cookie it can only present to api.makerbay.app. The SPA on
 *   app.makerbay.app needs a bearer token, so this mints a single-use token
 *   from that cookie and sends the browser to the SPA with it in the URL
 *   fragment - which never reaches a server log.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const auth = await getAuth()
  if (event.rawPath === '/auth-bridge') return bridge(event, auth)
  const res = await auth.handler(toRequest(event))
  return toResult(res)
}

async function bridge(event: APIGatewayProxyEventV2, auth: Awaited<ReturnType<typeof getAuth>>): Promise<APIGatewayProxyResultV2> {
  const spa = process.env.AUTH_SPA_URL ?? '/'
  try {
    const { token } = await auth.api.generateOneTimeToken({ headers: toRequest(event).headers })
    return { statusCode: 302, headers: { location: `${spa}/#ott=${encodeURIComponent(token)}` }, body: '' }
  } catch (err) {
    console.warn('auth bridge without a session', { err: String((err as Error)?.message ?? err) })
    return { statusCode: 302, headers: { location: `${spa}/#auth_error=no_session` }, body: '' }
  }
}
