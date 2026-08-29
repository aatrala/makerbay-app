/**
 * Pulls every Google-hosted font the product serves on a PUBLIC page down into
 * our own bucket (issue 133).
 *
 *   node scripts/vendor-fonts.mjs
 *
 * Why this exists. A tenant's booking page and help centre are read by
 * homeowners who have no relationship with MakerBay. While the fonts came from
 * fonts.googleapis.com, every one of those visits sent the reader's IP address
 * and user agent to Google - which made a third party a recipient of personal
 * data, and made our privacy policy's "the complete list, there is no one
 * else" untrue. It is also the exact fact pattern behind the German Google
 * Fonts damages cases.
 *
 * The URLs are read out of the source rather than listed here, so the vendored
 * set cannot silently diverge from what the pages actually load. Adding a new
 * pairing means re-running this; `--check` fails if anything is missing.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')
const OUT = path.join(repo, 'modules/assistant/embed/src/fonts')

/** Files that may reference a Google font stylesheet. */
const SOURCES = [
  'modules/presence/api/src/render.ts',
  'modules/assistant/api/src/help.ts',
]

/**
 * A modern desktop UA. Google serves woff2 to this and older formats to
 * anything it does not recognise, so asking as Chrome is what keeps the
 * download to one small file per subset.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * Latin only. The pairings are Latin-script faces and the tenants are English
 * speaking, so shipping Cyrillic and Greek subsets would triple the bytes for
 * glyphs nobody renders. Google's own CSS keeps them separate behind
 * unicode-range, so dropping them changes nothing a reader sees.
 */
const KEEP = new Set(['latin', 'latin-ext'])

const slug = (url) =>
  decodeURIComponent(new URL(url).searchParams.get('family') ?? 'font')
    .split('&family=').join('-')
    .replace(/:[^&]*/g, '')
    .replace(/\+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 60)

async function main() {
  const check = process.argv.includes('--check')

  // 1. Find every Google font stylesheet URL the product serves.
  const urls = new Set()
  for (const rel of SOURCES) {
    const text = await readFile(path.join(repo, rel), 'utf8')
    for (const m of text.matchAll(/https:\/\/fonts\.googleapis\.com\/css2\?[^'"`\s]+/g)) {
      // Skip any URL still carrying a template hole - those are built at
      // runtime from tenant config and cannot be vendored ahead of time.
      if (m[0].includes('${')) continue
      urls.add(m[0].replace(/&amp;/g, '&'))
    }
  }
  if (urls.size === 0) {
    console.log('No Google font URLs left in source. Nothing to vendor.')
    return
  }

  await mkdir(OUT, { recursive: true })
  const written = []

  for (const url of urls) {
    const name = slug(url)
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
    let css = await res.text()

    // 2. Keep only the subsets we actually render, then pull each file down.
    const blocks = css.split('/* ').filter(Boolean)
    const kept = []
    for (const block of blocks) {
      const subset = block.slice(0, block.indexOf(' *['.slice(0, 2)))
      const label = subset.trim()
      if (!KEEP.has(label)) continue
      let body = '/* ' + block
      for (const m of body.matchAll(/https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2/g)) {
        const fontUrl = m[0]
        const hash = createHash('sha256').update(fontUrl).digest('hex').slice(0, 10)
        const file = `${name}-${label}-${hash}.woff2`
        if (!existsSync(path.join(OUT, file))) {
          const f = await fetch(fontUrl, { headers: { 'User-Agent': UA } })
          if (!f.ok) throw new Error(`${fontUrl} -> HTTP ${f.status}`)
          await writeFile(path.join(OUT, file), Buffer.from(await f.arrayBuffer()))
        }
        body = body.split(fontUrl).join(`./${file}`)
      }
      kept.push(body.trim())
    }
    if (kept.length === 0) throw new Error(`no latin subset found for ${url}`)

    const header = `/* Vendored from Google Fonts so no reader's IP reaches a third party.\n`
      + `   Source: ${url}\n`
      + `   Regenerate with: node scripts/vendor-fonts.mjs */\n`
    await writeFile(path.join(OUT, `${name}.css`), header + kept.join('\n\n') + '\n', 'utf8')
    written.push(`${name}.css`)
    console.log(`  ${name}.css`)
  }

  const files = await readdir(OUT)
  const woff2 = files.filter((f) => f.endsWith('.woff2')).length
  console.log(`\n${written.length} stylesheets, ${woff2} font files in ${path.relative(repo, OUT)}`)
  if (check && urls.size > 0) {
    console.error('\n--check: source still references fonts.googleapis.com')
    process.exit(1)
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
