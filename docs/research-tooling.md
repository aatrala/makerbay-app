# Research tooling — connected MCP data sources

How we gather market/module intelligence for MakerBay. Two MCP connectors are
set up on the Claude account (2026-08-23). They are account-level connectors,
not part of this repo — nothing here holds credentials.

## Bright Data MCP

**What it is:** SERP search + unblocked web scraping (handles bot detection
and CAPTCHA). This is how we read sources that block normal fetching — G2
review pages (403 otherwise) and Reddit threads (blocks crawlers).

**Tools exposed** (names as they appear in a Claude session):

| Tool | Use |
|---|---|
| `search_engine` / `search_engine_batch` | Google/Bing/Yandex SERP results (batch = up to 10 queries) |
| `scrape_as_markdown` / `scrape_batch` | Any URL → markdown, even bot-protected (batch = up to 10 URLs) |
| `ask_brightdata_assistant` | Bright Data's own helper agent |

**Usage pattern that works:**
1. `search_engine_batch` with `site:reddit.com/r/<sub> <topic>` queries to find
   thread permalinks.
2. `scrape_batch` on the best permalinks (`old.reddit.com` URLs scrape cleaner)
   or on G2 review pages directly.

**Cost/care:** metered per request — batch tools, small curated URL lists, no
broad crawls. Scraped pages are long; extract findings immediately rather than
accumulating raw dumps.

## Apify MCP

**What it is:** marketplace of hosted scrapers ("actors"), including
multi-platform software-review scrapers (G2, Capterra, Trustpilot, Software
Advice) that return structured reviews: rating, date, pros/cons, reviewer
segment.

**Tools exposed:**

| Tool | Use |
|---|---|
| `search-actors` | Find actors by keyword (e.g. "capterra reviews") |
| `fetch-actor-details` | Input schema + pricing model — always check before running |
| `call-actor` | Run an actor with JSON input |
| `get-actor-run` | Poll async runs |
| `get-dataset-items` | Fetch results (pass a small `limit`) |
| `apify--rag-web-browser` | General web browse/extract actor |

**Cost/care:** actors bill per run/result against the Apify account. Always
`fetch-actor-details` first to check pricing, set every max/limit field the
input schema offers (~20-30 reviews per product is plenty for theme analysis),
and pull datasets with a small `limit`.

## Not yet connected (evaluated 2026-08)

- **X.com official MCP** (`api.x.com/mcp`, reported June 2026): free MCP layer
  over the pay-per-use X API (~$0.005/post read reported). Useful for
  founder/SMB sentiment; full-archive search is enterprise-only, so
  recent-window queries only.
- **Similarweb** (via the product-management plugin): competitor traffic
  intelligence; needs OAuth in claude.ai connector settings.
- Search MCPs (Exa, Tavily, Brave, Perplexity, Firecrawl): redundant while
  Bright Data covers SERP + scraping.

## The recurring sweep (recipe)

Findings live in [market-research.md](market-research.md) and the published
report artifact linked there. To re-run or extend the sweep, fan out parallel
research agents, one per source, each returning structured markdown (ranked
opportunities, named-product complaints, module verdicts, source URLs):

1. **Product Hunt** — launch traction for SMB tool categories (plain web search
   works; producthunt.com is fetchable).
2. **G2** — category leaders, ratings, complaint themes (Bright Data scrape;
   direct fetch is blocked).
3. **Capterra/GetApp/Software Advice** — shortlists + review pages (mostly
   fetchable directly; Apify actors for structured review pulls).
4. **Reddit** — r/smallbusiness, r/sweatystartup, vertical subs, r/agency
   (Bright Data scrape; direct fetch is blocked).
5. **Structured reviews** — Apify multi-platform review actors for
   pros/cons/star-distribution on named incumbents.

Cross-check every claim across at least two sources; mark unverified figures.
Feed conclusions into SPEC.md module sections and the roadmap.
