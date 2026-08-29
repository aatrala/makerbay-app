/**
 * Draws the MakerBay app icons (issue 145).
 *
 *   node scripts/make-icons.mjs
 *
 * The dashboard had no icon and the site had no favicon at all, so a manifest
 * would have pointed at nothing and a bookmarked tab showed a blank page.
 *
 * Generated rather than drawn in a design tool for the same reason the module
 * pages are generated: it is one definition, it is in the repo, and changing
 * the brand colour changes every size at once. No dependencies - PNG is a
 * container around zlib, and zlib is in Node.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

const ACCENT = [0xc2, 0x41, 0x0c] // --accent, the same orange as everything else
const WHITE = [0xff, 0xff, 0xff]

/**
 * A bold M, as one polygon in a unit box. Four strokes and a valley, which is
 * the whole letter - and straight edges mean a point-in-polygon test is all
 * the rasterising this needs.
 */
const M = [
  [0.18, 0.79], [0.18, 0.21], [0.32, 0.21], [0.50, 0.49], [0.68, 0.21],
  [0.82, 0.21], [0.82, 0.79], [0.695, 0.79], [0.695, 0.44], [0.535, 0.68],
  [0.465, 0.68], [0.305, 0.44], [0.305, 0.79],
]

const inPolygon = (x, y, poly) => {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Rounded-square coverage, so the corners are not jagged. */
const inRoundedSquare = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 1 - r)
  const cy = Math.min(Math.max(y, r), 1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

const crc32 = (buf) => {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/**
 * @param size pixels square
 * @param pad  fraction of the canvas left empty around the mark. Android's
 *             maskable icons crop to a circle, so that variant needs more.
 */
function icon(size, pad = 0) {
  // 4x supersampling: an icon with a stair-stepped M looks amateur at any size.
  const S = 4
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4)
    for (let x = 0; x < size; x++) {
      let bg = 0
      let fg = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size
          const v = (y + (sy + 0.5) / S) / size
          if (!inRoundedSquare(u, v, 0.22)) continue
          bg++
          // The mark sits inside the padding, scaled about the centre.
          const scale = 1 - pad * 2
          const mu = (u - 0.5) / scale + 0.5
          const mv = (v - 0.5) / scale + 0.5
          if (inPolygon(mu, mv, M)) fg++
        }
      }
      const total = S * S
      const alpha = Math.round((bg / total) * 255)
      const mix = fg / total
      const px = 1 + x * 4
      for (let c = 0; c < 3; c++) {
        row[px + c] = Math.round(ACCENT[c] * (1 - mix) + WHITE[c] * mix)
      }
      row[px + 3] = alpha
    }
    rows.push(row)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const targets = [
  ['web/public/icon-192.png', 192, 0],
  ['web/public/icon-512.png', 512, 0],
  // Maskable icons are cropped to a circle on Android; the mark has to survive
  // losing the corners, so it gets a wider margin.
  ['web/public/icon-maskable-512.png', 512, 0.1],
  ['web/public/favicon-32.png', 32, 0],
  ['site/src/assets/favicon-32.png', 32, 0],
  ['site/src/assets/icon-192.png', 192, 0],
]

for (const [rel, size, pad] of targets) {
  const out = join(repo, rel)
  mkdirSync(dirname(out), { recursive: true })
  const png = icon(size, pad)
  writeFileSync(out, png)
  console.log(`${rel} (${size}px, ${png.length} bytes)`)
}
