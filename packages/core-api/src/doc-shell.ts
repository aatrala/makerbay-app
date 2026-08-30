import { getTenantBySlugOrAlias } from '@makerbay/core'
import { esc } from '@makerbay/email'
import { htmlResponse } from './html'

/**
 * The HTML shell behind a quote or invoice link (issue 118 phase 2).
 *
 * Why this exists: pasted into WhatsApp, a MakerBay document link produced a
 * card saying "Chat" on an unfamiliar domain, because the shell is a static
 * file with `<title>Chat</title>` and no Open Graph tags, and the real title
 * is set by JavaScript that no link crawler runs. An unlabelled link from an
 * unknown number is exactly what a homeowner has been taught not to tap.
 *
 * WHY IT IS A SEPARATE FUNCTION, and not a route on the quotes handler:
 *
 * The requirement is that the preview generator be structurally incapable of
 * putting a price or a customer's name on a card that lands in a group chat.
 * "We don't query the quote" is a convention one refactor away from being
 * false, so it is enforced three ways instead:
 *
 * 1. ROUTING. The CloudFront function strips the token from the URL before
 *    the cache lookup and before the origin request. This function is never
 *    given the credential, so no code added to it later can read the row.
 * 2. IAM. Its role has read access to tenants and slug aliases and to nothing
 *    else, with an explicit Deny on the quotes and invoices tables. Bolting
 *    this onto the quotes handler would have run it inside a role holding
 *    read/write on every quote.
 * 3. INPUT. All it receives is a slug and a kind. There is no argument here
 *    that could identify a document even if someone wanted one.
 *
 * The card therefore carries the business name and nothing else. It cannot
 * carry the amount, because the amount is unreachable from here.
 */

/** Where the page's own script and styles live. Unchanged by this work. */
const ASSETS = 'https://chat.makerbay.app'

interface ShellEvent {
  rawPath?: string
  queryStringParameters?: Record<string, string | undefined>
}

// The card is cached by the messaging app per URL and never purged, so a
// short origin TTL is all we control. Long enough that a tradesperson
// sending ten links in a row hits cache; short enough that a rename shows
// up the same afternoon on links sent after it.
const html = (body: string, status = 200) =>
  htmlResponse(body, { status, cacheControl: 'public, max-age=300, s-maxage=300' })

/**
 * A card for a document that could not be resolved.
 *
 * Deliberately says nothing about why. An unknown slug and a revoked link look
 * identical from outside, which is the only answer that does not turn the
 * preview into an oracle for which businesses exist.
 */
const unknownShell = () => html(page({
  title: 'MakerBay',
  ogTitle: 'MakerBay',
  site: 'MakerBay',
  description: 'Open this link to see the document.',
}), 404)

function page(v: { title: string; ogTitle: string; site: string; description: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(v.title)}</title>
<meta name="description" content="${esc(v.description)}" />
<!--
  noindex is kept from the original shell. It does NOT stop the WhatsApp and
  iMessage crawlers, which ignore it when building a preview - which is what
  we want here: a card for the recipient, no entry in a search index.
-->
<meta name="robots" content="noindex, nofollow" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(v.ogTitle)}" />
<meta property="og:description" content="${esc(v.description)}" />
<!-- The business, not us. The customer is deciding whether they trust their
     tradesperson, and has never heard of MakerBay. -->
<meta property="og:site_name" content="${esc(v.site)}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${esc(v.ogTitle)}" />
<meta name="twitter:description" content="${esc(v.description)}" />
<!--
  No og:url. This function is never given the token, so it could not echo the
  link even by accident - and a canonical URL without one would point at a
  page that does not resolve.

  No og:image either, for now. The only image available is the presence hero
  photo, which has no size or dimension limit: a phone photo straight off a
  4 MB camera roll is silently dropped by WhatsApp and produces no card at
  all. A text card that always renders beats an image card that sometimes
  vanishes. Revisit with a real logo upload and a bounded derivative.
-->
<link rel="stylesheet" href="${ASSETS}/chat.css" />
</head>
<body>
<div id="app"></div>
<script src="${ASSETS}/pages.js"></script>
</body>
</html>`
}

export const handler = async (event: ShellEvent) => {
  const q = event.queryStringParameters ?? {}
  const slug = String(q.slug ?? '').trim()
  const kind = q.kind === 'invoice' ? 'invoice' : 'quote'
  if (!slug) return unknownShell()

  try {
    const tenant = await getTenantBySlugOrAlias(slug)
    if (!tenant?.name) return unknownShell()
    const noun = kind === 'invoice' ? 'Invoice' : 'Quote'
    return html(page({
      title: `${noun} from ${tenant.name}`,
      ogTitle: `${noun} from ${tenant.name}`,
      site: tenant.name,
      // A fixed sentence. Nothing derived from the document, because nothing
      // about the document is reachable from here.
      description: kind === 'invoice'
        ? `An invoice from ${tenant.name}. Open it to see the details and how to pay.`
        : `A quote from ${tenant.name}. Open it to see the price.`,
    }))
  } catch (err) {
    console.error('doc shell failed', { slug, kind, err: String(err) })
    // Still serve a page: the customer's document is fine, only the card is
    // not, and a 500 here would break the link itself.
    return unknownShell()
  }
}
