import { applyUnsubscribe, getTenant, resolveUnsub } from '@makerbay/core'

/**
 * The page behind an unsubscribe link (issue 121).
 *
 * Two callers, and they must behave differently:
 *
 * POST is the mail client acting on the recipient's behalf - Gmail's and Apple
 * Mail's own one-tap control, per RFC 8058. It must take effect immediately
 * and MUST NOT ask anything: there is no human looking at a page, and a
 * confirmation step means the unsubscribe silently never happens.
 *
 * GET is a person who clicked the text link. It also takes effect immediately
 * rather than showing a "confirm?" button, because a link in an email is
 * already a deliberate act and a second step is where people give up and
 * press spam instead - which is the outcome this whole feature exists to
 * avoid.
 *
 * Neither identifies the recipient to anyone. The page says which business
 * has stopped mailing them, never who they are.
 */

const html = (body: string, status = 200) => ({
  statusCode: status,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    // Never cached: the answer changes the moment it is acted on, and a CDN
    // holding "you are unsubscribed" for the next person would be worse than
    // useless.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  },
  body,
})

const esc = (s: string): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function page(heading: string, detail: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(heading)}</title>
<meta name="robots" content="noindex, nofollow" />
<style>
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color: #1c1917; background: #faf9f7; margin: 0; padding: 40px 20px; }
  main { max-width: 480px; margin: 0 auto; background: #fff; border: 1px solid #e7e5e4;
         border-radius: 12px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { margin: 0 0 12px; color: #57534e; }
</style>
</head>
<body><main><h1>${esc(heading)}</h1><p>${esc(detail)}</p></main></body>
</html>`
}

export const handler = async (event: {
  requestContext?: { http?: { method?: string } }
  queryStringParameters?: Record<string, string | undefined>
}) => {
  const token = String(event.queryStringParameters?.t ?? '')
  const target = await resolveUnsub(token)

  if (!target) {
    // Deliberately the same answer as a token that has already been used, and
    // it says nothing about whether the address exists. A link that reports
    // "unknown address" is an address-checking oracle for anyone with a list.
    return html(page(
      'This link has expired',
      'It may already have been used. If you are still getting messages you do not want, '
      + 'reply to one of them and ask to be taken off the list.',
    ), 404)
  }

  await applyUnsubscribe(target)

  const tenant = await getTenant(target.tenantId).catch(() => undefined)
  const who = tenant?.name ?? 'this business'
  return html(page(
    'Done - you are unsubscribed',
    `${who} will stop sending you review requests and updates. `
    + 'Anything you actually asked for, like a quote or an invoice, will still reach you.',
  ))
}
