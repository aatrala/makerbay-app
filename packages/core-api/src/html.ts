/**
 * The one HTML Lambda-response builder for public pages served by core-api.
 *
 * Two hand-written copies of this existed in the same package, identical but
 * for the cache-control value - which is exactly the parameter. The security
 * headers stay together on purpose: a public page that loses nosniff or
 * no-referrer in a copy-paste is the kind of drift nobody notices until it
 * matters.
 */
export const htmlResponse = (
  body: string,
  opts: { status?: number; cacheControl: string },
) => ({
  statusCode: opts.status ?? 200,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': opts.cacheControl,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  },
  body,
})
