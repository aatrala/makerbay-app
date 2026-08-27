import chromium from '@sparticuz/chromium'
import puppeteer from 'puppeteer-core'
import { assertPublicUrl } from '@makerbay/scrape'

/**
 * Headless-browser rescue for JavaScript-drawn pages. A separate Lambda on
 * purpose: Chromium needs x86_64, two gigabytes and a cold start none of
 * the API functions should pay. Called only after the static scrape, the
 * markdown twin and the Next.js data have all come back empty.
 *
 * Same SSRF posture as the static path: the target must resolve public
 * before navigation, and every subrequest to an IP-literal private address
 * is aborted - a rendered page must not become a proxy into the metadata
 * service.
 */

const MAX_HTML = 2 * 1024 * 1024
const NAV_TIMEOUT_MS = 15_000

const PRIVATE_IP =
  /^(https?:\/\/)(\[?::1\]?|\[?::ffff:[^/]+\]?|127\.|10\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/i

interface RenderRequest {
  url?: string
}

export const handler = async (
  event: RenderRequest,
): Promise<{ html?: string; finalUrl?: string; error?: string }> => {
  const raw = String(event.url ?? '')
  try {
    await assertPublicUrl(raw)
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'bad_url' }
  }

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 900 },
    executablePath: await chromium.executablePath(),
    headless: true,
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent('MakerBayBot/1.0 (+https://makerbay.app; assistant knowledge)')
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      const u = req.url()
      if (!/^https?:\/\//i.test(u) || PRIVATE_IP.test(u)) {
        void req.abort()
        return
      }
      // Rendering needs the page's scripts and data, not its pixels.
      if (['image', 'media', 'font'].includes(req.resourceType())) {
        void req.abort()
        return
      }
      void req.continue()
    })

    await page.goto(raw, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS }).catch(() => {
      // Timeouts still often leave a usable DOM - read what rendered.
    })
    // One breath for the last framework paint after network idle.
    await new Promise((r) => setTimeout(r, 400))

    const html = await page.content()
    return { html: html.slice(0, MAX_HTML), finalUrl: page.url() }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'render_failed' }
  } finally {
    await browser.close().catch(() => {})
  }
}
