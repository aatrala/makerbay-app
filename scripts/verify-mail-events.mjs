#!/usr/bin/env node
/**
 * End-to-end proof that a bounce and a complaint actually reach us (issue 107).
 *
 * Uses the SES mailbox simulator, which works while the account is still
 * sandboxed - so this verifies the whole pipeline today rather than after
 * production access is granted. The simulator addresses do not count towards
 * the account's bounce or complaint reputation.
 *
 * It sends through the real configuration set with the real EmailTags, so what
 * it exercises is the same path a quote takes: SES -> event destination ->
 * default EventBridge bus -> rule -> mail-events Lambda -> MailLog + status +
 * row write-back.
 *
 *   node scripts/verify-mail-events.mjs
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

// A tenant id that is obviously synthetic, so nothing here can be mistaken for
// a real workspace's mail history.
const TENANT = 'VERIFY-MAIL-EVENTS'

const ses = new SESv2Client({ region: REGION })
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))

const CASES = [
  { name: 'bounce', to: 'bounce@simulator.amazonses.com', expect: 'bounced', refId: 'VERIFY-B' },
  { name: 'complaint', to: 'complaint@simulator.amazonses.com', expect: 'complained', refId: 'VERIFY-C' },
  { name: 'success', to: 'success@simulator.amazonses.com', expect: 'delivered', refId: 'VERIFY-S' },
]

async function send({ to, refId }) {
  const r = await ses.send(new SendEmailCommand({
    FromEmailAddress: FROM,
    Destination: { ToAddresses: [to] },
    ConfigurationSetName: CONFIG_SET,
    EmailTags: [
      { Name: 'tenantId', Value: TENANT },
      { Name: 'refType', Value: 'quote' },
      { Name: 'refId', Value: refId },
      { Name: 'audience', Value: 'customer' },
    ],
    Content: {
      Simple: {
        Subject: { Data: 'MakerBay delivery pipeline check' },
        Body: { Text: { Data: 'Automated check of the bounce and complaint pipeline. No action needed.' } },
      },
    },
  }))
  return r.MessageId
}

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
