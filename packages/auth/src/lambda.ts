import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'

/**
 * API Gateway v2 events to and from the Web `Request`/`Response` that
 * Better Auth's handler speaks (issue 157). About forty lines, and the only
 * place the two worlds touch.
 */
export function toRequest(event: APIGatewayProxyEventV2): Request {
  const host = event.headers?.host ?? event.requestContext.domainName
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : ''
  const url = `https://${host}${event.rawPath}${qs}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers.set(k, v)
  // HTTP APIs strip Cookie into a separate array; Better Auth reads the header.
  if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '))
  const method = event.requestContext.http.method
  const hasBody = event.body !== undefined && method !== 'GET' && method !== 'HEAD'
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body as string, 'base64')
      : (event.body as string)
    : undefined
  return new Request(url, { method, headers, body })
}

export async function toResult(res: Response): Promise<APIGatewayProxyResultV2> {
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    if (k.toLowerCase() !== 'set-cookie') headers[k] = v
  })
  const cookies = res.headers.getSetCookie()
  return {
    statusCode: res.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: await res.text(),
  }
}
