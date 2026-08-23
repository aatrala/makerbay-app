# Website knowledge and source transparency

## Why

Today a business must upload documents before the assistant knows anything.
But the content already exists — on their website. "Point at your site" removes
the largest step in onboarding, and it is what an SMB expects the product to do.

It is also a prerequisite for the buyer experiment: building demo assistants
from real businesses' public websites is not possible without it.

The second half is trust. A business will not put an assistant in front of
customers if it cannot see what the assistant learned. Every source must be
inspectable: what it is, when it arrived, and what text was actually extracted.

## Scope (v1)

**Add by URL.** Paste one or more URLs. Each page is fetched, reduced to
readable text, and stored as a source like any other.

**Discover pages.** Given a site root, read `sitemap.xml` (and `/llms.txt` when
present, which is written precisely for this) and return a candidate list. The
owner ticks the pages they want. We never bulk-import without a human choosing.

**Preview.** For every source: type, size, added date, status, and the actual
extracted text. For uploaded files, a time-limited link to the original.

**Refresh.** Re-fetch a URL source on demand; the page is replaced, not
duplicated.

## Deliberately not in v1

Scheduled re-crawling, JavaScript rendering, PDF-at-URL ingestion, whole-site
recursive crawling, and per-page CSS selector configuration.

## Safety

**SSRF.** The server fetches URLs an untrusted user supplies, so it must never
be usable as a proxy into private networks. Only `http`/`https`; the resolved
address must be public — loopback, link-local (including the cloud metadata
endpoint at `169.254.169.254`), and RFC1918 ranges are refused. Redirects are
followed manually, with every hop re-checked, and capped.

**robots.txt is respected.** The user asserts they own the site, but we cannot
verify that, and a tool that fetches any URL on demand must not become a
scraping service. When robots.txt disallows a path we say so plainly rather
than fetching anyway.

**Budget.** Response size, page count, and total time are all capped, and pages
count against the plan's source limit like any other document.

## The limitation to state honestly

Many modern sites render their content with JavaScript. Fetching such a page
returns an almost empty shell — this product's own test corpus behaved exactly
that way. We do not render JavaScript, so when extraction yields very little
text we tell the user the page appears to be JavaScript-rendered and suggest
the alternatives (a sitemap entry, `/llms.txt`, or pasting the content), rather
than silently storing an empty document and letting the assistant look broken.

## Data model

`Sources` gains:

| field | meaning |
|---|---|
| `type` | `file` \| `text` \| `url` |
| `sourceUrl` | the page fetched, for `url` sources |
| `fetchedAt` | when the content was last retrieved |
| `charCount` | extracted text length, the honest measure of what was learned |
| `warning` | e.g. `looks_javascript_rendered` |

## API

| route | purpose |
|---|---|
| `POST /v1/assistant/sources` with `type: "url"` | add one page |
| `POST /v1/assistant/sources/discover` | list candidate pages for a site |
| `POST /v1/assistant/sources/{id}/refresh` | re-fetch a URL source |
| `GET /v1/assistant/sources/{id}/preview` | extracted text, metadata, file link |
