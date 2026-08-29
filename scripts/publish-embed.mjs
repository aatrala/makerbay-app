#!/usr/bin/env node
/**
 * Publish the customer-facing pages to the embed bucket.
 *
 * These files are NOT deployed by CDK. There is no BucketDeployment in the
 * stack, so `cdk deploy` ships every Lambda and leaves chat.css, pages.js,
 * chat.js, widget.js and index.html exactly as they were - which is how a JS
 * change can pass every test, deploy "successfully", and still not be live.
 * That cost a real debugging round on issue 118 phase 2: the server-rendered
 * shell was correct while the script it loaded was two days stale, so the
 * customer page would have said "This link is not valid."
 *
 *   node scripts/publish-embed.mjs            # publish and invalidate
 *   node scripts/publish-embed.mjs --check    # report drift, change nothing
 *
 * Cache-control is set explicitly. The shell references these by fixed
 * unversioned URLs, so without a short TTL a browser holds a stale script for
 * hours - the same failure as issue 92 on the marketing site, where new HTML
 * shipped against cached CSS.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { CloudFrontClient, CreateInvalidationCommand, GetInvalidationCommand } from '@aws-sdk/client-cloudfront'

const REGION = 'us-east-1'
const BUCKET = process.env.EMBED_BUCKET ?? 'makerbay-embed-953146692138'
const DISTRIBUTION = process.env.EMBED_DISTRIBUTION ?? 'E3L7386L2Y8F0Y'
const SRC = path.join(process.cwd(), 'modules/assistant/embed/src')
const CHECK_ONLY = process.argv.includes('--check')

const TYPES = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.woff2': 'font/woff2',
}
/** Short, because the shell references these unversioned. */
const CACHE = 'public, max-age=300, must-revalidate'
/**
 * Fonts are different: the filename carries a hash of the source URL, so a
 * given file's bytes never change. A year is the point of vendoring them -
 * the reader fetches each face once instead of on every visit.
 */
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable'
const cacheFor = (name) => (name.endsWith('.woff2') ? CACHE_IMMUTABLE : CACHE)

const s3 = new S3Client({ region: REGION })
const cf = new CloudFrontClient({ region: REGION })

const md5 = (buf) => createHash('md5').update(buf).digest('hex')

/**
 * Recursive, so the vendored fonts under fonts/ are published too. The key
 * keeps the subdirectory, because the stylesheets reference the woff2 files
 * relatively and would 404 against a flattened bucket.
 */
const walk = async (dir, prefix = '') => {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), rel)))
    else if (TYPES[path.extname(e.name)]) out.push(rel)
  }
  return out
}
const files = await walk(SRC)
if (files.length === 0) {
  console.error(`No publishable files in ${SRC}`)
  process.exit(2)
}

const changed = []
for (const name of files) {
  const body = await readFile(path.join(SRC, name))
  // S3 returns the MD5 as the ETag for a single-part upload, which is what
  // every one of these is. Comparing it means an unchanged file is not
  // republished, so the invalidation list stays honest.
  let live
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: name }))
    live = String(head.ETag ?? '').replace(/"/g, '')
  } catch {
    live = undefined
  }
  const local = md5(body)
  const differs = live !== local
  console.log(`${differs ? 'CHANGED ' : 'same    '} ${name}`)
  if (!differs) continue
  changed.push(name)
  if (CHECK_ONLY) continue
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: name,
    Body: body,
    ContentType: TYPES[path.extname(name)],
    CacheControl: cacheFor(name),
  }))
}

if (CHECK_ONLY) {
  console.log(`\n${changed.length} file(s) differ from the bucket.`)
  // Non-zero when drifted, so this can gate a release.
  process.exit(changed.length === 0 ? 0 : 1)
}

if (changed.length === 0) {
  console.log('\nNothing to publish.')
  process.exit(0)
}

// Invalidate only what changed. A blanket /* is billed beyond the free
// allowance and buys nothing here.
const inv = await cf.send(new CreateInvalidationCommand({
  DistributionId: DISTRIBUTION,
  InvalidationBatch: {
    CallerReference: `publish-embed-${md5(changed.join(','))}-${changed.length}-${process.pid}`,
    Paths: { Quantity: changed.length, Items: changed.map((f) => `/${f}`) },
  },
}))
const id = inv.Invalidation.Id
console.log(`\ninvalidating ${changed.length} path(s): ${id}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 40; i++) {
  const r = await cf.send(new GetInvalidationCommand({ DistributionId: DISTRIBUTION, Id: id }))
  if (r.Invalidation.Status === 'Completed') {
    console.log('done')
    process.exit(0)
  }
  await sleep(5000)
}
console.log('still in progress; it will finish on its own')
