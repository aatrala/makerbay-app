#!/usr/bin/env node
/**
 * End-to-end proof that a bounce and a complaint actually reach us (issue 107).
 *
 * Two providers, one pipeline (issue 156). Pick with --provider:
 *
 *   node scripts/verify-mail-events.mjs                  # SES (default)
 *   node scripts/verify-mail-events.mjs --provider resend
 *
 * SES uses the mailbox simulator, which works while the account is still
 * sandboxed, so it verifies the whole pipeline today rather than after
 * production access is granted. The simulator addresses do not count towards
 * the account's bounce or complaint reputation.
 *
 * Resend uses its own test addresses (bounced@, complained@, delivered@
 * resend.dev), which likewise leave domain reputation alone but DO count
 * against the account's daily quota. It needs RESEND_API_KEY in the
 * environment. Per CLAUDE.md, never paste the key: resolve it at runtime,
 * for example with asm-exec and
 * {{resolve:secretsmanager:makerbay/resend:SecretString:apiKey}}.
 *
 * Both paths send with the real tags and end in the same place: MailLog +
 * per-tenant address status + row write-back, via the mail-events Lambda.
 * For SES the route is the config set's EventBridge destination; for Resend
 * it is the signed webhook at /v1/mail/webhook, so a green run here also
 * proves the webhook and its secret are wired.
 *
 * Nothing here writes to a real person's address.
 */

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'

const REGION = process.env.AWS_REGION ?? 'us-east-1'
const CONFIG_SET = process.env.EMAIL_CONFIG_SET ?? 'makerbay-transactional'
const FROM = process.env.EMAIL_FROM ?? 'hello@makerbay.app'
const MAILLOG = process.env.TABLE_MAILLOG ?? 'makerbay-maillog'

const argProvider = process.argv.indexOf('--provider')
const PROVIDER = argProvider > -1 ? process.argv[argProvider + 1] : (process.env.EMAIL_PROVIDER ?? 'ses')
if (!['ses', 'resend'].includes(PROVIDER)) {
  console.error(`unknown provider "${PROVIDER}": use ses or resend`)
  process.exit(2)
}

// A tenant id that is obviously synthetic, so nothing here can be mistaken for
// a real workspace's mail history.
const TENANT = 'VERIFY-MAIL-EVENTS'

const ses = new SESv2Client({ region: REGION })
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))

const CASES = PROVIDER === 'resend'
  ? [
      { name: 'bounce', to: 'bounced@resend.dev', expect: 'bounced', refId: 'VERIFY-B' },
      { name: 'complaint', to: 'complained@resend.dev', expect: 'complained', refId: 'VERIFY-C' },
      { name: 'success', to: 'delivered@resend.dev', expect: 'delivered', refId: 'VERIFY-S' },
    ]
  : [
      { name: 'bounce', to: 'bounce@simulator.amazonses.com', expect: 'bounced', refId: 'VERIFY-B' },
      { name: 'complaint', to: 'complaint@simulator.amazonses.com', expect: 'complained', refId: 'VERIFY-C' },
      { name: 'success', to: 'success@simulator.amazonses.com', expect: 'delivered', refId: 'VERIFY-S' },
    ]

const TAGS = (refId) => ({ tenantId: TENANT, refType: 'quote', refId, audience: 'customer' })
const SUBJECT = 'MakerBay delivery pipeline check'
const TEXT = 'Automated check of the bounce and complaint pipeline. No action needed.'

async function sendSes({ to, refId }) {
  const r = await ses.send(new SendEmailCommand({
    FromEmailAddress: FROM,
    Destination: { ToAddresses: [to] },
    ConfigurationSetName: CONFIG_SET,
    EmailTags: Object.entries(TAGS(refId)).map(([Name, Value]) => ({ Name, Value })),
    Content: { Simple: { Subject: { Data: SUBJECT }, Body: { Text: { Data: TEXT } } } },
  }))
  return r.MessageId
}

async function sendResend({ to, refId }) {
  const key = process.env.RESEND_API_KEY
  if (!key) throw Object.assign(new Error('RESEND_API_KEY is not set'), { name: 'NotConfigured' })
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: SUBJECT,
      text: TEXT,
      tags: Object.entries(TAGS(refId)).map(([name, value]) => ({ name, value })),
    }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(json.message ?? `HTTP ${res.status}`), { name: json.name ?? `http_${res.status}` })
  // The webhook reports this id as email_id, and mail-events stores it as the
  // messageId, so it is what we poll for.
  return json.id
}

const send = PROVIDER === 'resend' ? sendResend : sendSes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll rather than assume: the event round trip is seconds, not instant. */
async function waitForState(messageId, want, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let seen = []
  while (Date.now() < deadline) {
    const r = await ddb.send(new QueryCommand({
      TableName: MAILLOG,
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': TENANT },
    }))
    const rows = (r.Items ?? []).filter((i) => i.messageId === messageId)
    seen = rows.map((i) => i.state)
    if (seen.includes(want)) return { ok: true, seen }
    await sleep(5000)
  }
  return { ok: false, seen }
}

async function addressStatus(email) {
  const r = await ddb.send(new GetCommand({
    TableName: MAILLOG,
    Key: { tenantId: TENANT, messageId: `addr#${email.toLowerCase()}` },
  }))
  return r.Item?.state
}

console.log(`provider: ${PROVIDER}`)
const results = []
for (const c of CASES) {
  process.stdout.write(`sending ${c.name} ... `)
  let messageId
  try {
    messageId = await send(c)
  } catch (err) {
    console.log(`FAILED to send: ${err.name}: ${err.message}`)
    results.push({ ...c, pass: false, detail: `send failed: ${err.name}` })
    continue
  }
  process.stdout.write(`${messageId}\n  waiting for "${c.expect}" ... `)
  const { ok, seen } = await waitForState(messageId, c.expect)
  const status = await addressStatus(c.to)
  console.log(ok ? `OK (states seen: ${seen.join(', ')})` : `TIMED OUT (states seen: ${seen.join(', ') || 'none'})`)
  if (c.expect !== 'delivered') console.log(`  address status: ${status ?? 'none'}`)
  results.push({ ...c, pass: ok, seen, status })
}

console.log('\n--- summary ---')
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(10)} states=${(r.seen ?? []).join(',') || '-'}  addressStatus=${r.status ?? '-'}`)
}

// The suppression is the half that costs money if it is wrong in either
// direction, so it is checked separately from the log.
const bounce = results.find((r) => r.name === 'bounce')
const complaint = results.find((r) => r.name === 'complaint')
const success = results.find((r) => r.name === 'success')
const checks = [
  ['bounce recorded', bounce?.pass],
  ['bounce suppressed the address', bounce?.status === 'bounced'],
  ['complaint recorded', complaint?.pass],
  ['complaint suppressed the address', complaint?.status === 'complained'],
  ['delivery recorded', success?.pass],
  ['delivery did NOT suppress', !success?.status],
]
console.log('')
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
