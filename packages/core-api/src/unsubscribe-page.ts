import { applyUnsubscribe, getTenant, resolveUnsub } from '@makerbay/core'
import { esc } from '@makerbay/email'
import { htmlResponse } from './html'

/**
 * The page behind an unsubscribe link (issue 121).
 *
 * Two callers, and they must behave differently:
 *
 * POST is the mail client acting on the recipient's behalf - Gmail's and Apple
 * Mail's own one-tap control, per RFC 8058 - or the button on the page below.
 * It takes effect immediately and MUST NOT ask anything: for the one-click
 * case there is no human looking at a page, and a confirmation step means the
 * unsubscribe silently never happens. RFC 8058 makes one-click POST-only for
 * exactly the reason the next paragraph exists.
 *
 * GET is at most a person who clicked the text link - and often nobody at
 * all. Outlook SafeLinks, corporate mail scanners and some antivirus GET
 * every URL in every message they deliver, so a GET that applies immediately
 * unsubscribes recipients who never clicked, silently, with no way for
 * anyone to notice. So GET shows one button and does nothing else. The
 * button is the whole page; someone who deliberately clicked "stop these"
 * presses it in the same second, and a prefetcher never presses it at all.
 *
 * Neither identifies the recipient to anyone. The page says which business
 * has stopped mailing them, never who they are.
 */

// Never cached: the answer changes the moment it is acted on, and a CDN
// holding "you are unsubscribed" for the next person would be worse than
// useless.
const html = (body: string, status = 200) =>
  htmlResponse(body, { status, cacheControl: 'no-store' })

function page(heading: string, detail: string, extra = ''): string {
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
  button { font: inherit; font-weight: 600; color: #fff; background: #1c1917;
           border: 0; border-radius: 8px; padding: 10px 18px; cursor: pointer; }
</style>
</head>
<body><main><h1>${esc(heading)}</h1><p>${esc(detail)}</p>${extra}</main></body>
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

  const method = String(event.requestContext?.http?.method ?? 'GET').toUpperCase()
  const tenant = await getTenant(target.tenantId).catch(() => undefined)
  const who = tenant?.name ?? 'this business'

  if (method !== 'POST') {
    return html(page(
      'Stop these emails?',
      `Press the button and ${who} will stop sending you review requests and updates. `
      + 'Anything you actually asked for, like a quote or an invoice, will still reach you.',
      `<form method="post" action="/v1/public/unsubscribe?t=${esc(encodeURIComponent(token))}">`
      + '<button type="submit">Stop these emails</button></form>',
    ))
  }

  await applyUnsubscribe(target)

  return html(page(
    'Done - you are unsubscribed',
    `${who} will stop sending you review requests and updates. `
    + 'Anything you actually asked for, like a quote or an invoice, will still reach you.',
  ))
}
