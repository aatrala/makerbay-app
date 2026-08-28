#!/usr/bin/env node
/**
 * Proof that a quote works with no email address at all (issue 118).
 *
 * Invokes the DEPLOYED quotes Lambda with synthetic API Gateway events, so it
 * exercises the real shipped artifact rather than a local copy. The
 * authenticated calls carry an authorizer context, exactly as the real
 * authorizer would produce; the public calls carry none, exactly as a
 * customer's browser produces.
 *
 *   node scripts/verify-share-flow.mjs [tenantSlug]
 *
 * It creates two throwaway quotes on the named tenant (default: the Harbour
 * test workspace) and prints their ids so they can be removed.
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'

const REGION = 'us-east-1'
const FN = process.env.QUOTES_FN ?? 'Makerbay-QuotesApiFn87AA0786-gcmuhNLQC6ZV'
const SLUG = process.argv[2] ?? 'harbour-test-plumbing'

const lambda = new LambdaClient({ region: REGION })
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

async function tenantBySlug(slug) {
  const r = await ddb.send(new QueryCommand({
    TableName: 'makerbay-tenants',
    IndexName: 'bySlug',
    KeyConditionExpression: 'slug = :s',
    ExpressionAttributeValues: { ':s': slug },
  }))
  return r.Items?.[0]
}

/**
 * The users table is keyed on userId alone with no tenant index, so this
 * scans. Fine for a verification script against a handful of test rows; it
 * would not be fine in product code, which is why listTenantUsers lives in
 * packages/core and does the same thing behind one function.
 */
async function ownerUserId(tenantId) {
  const r = await ddb.send(new ScanCommand({
    TableName: 'makerbay-users',
    FilterExpression: 'tenantId = :t',
    ExpressionAttributeValues: { ':t': tenantId },
  }))
  const rows = r.Items ?? []
  return (rows.find((u) => u.role === 'owner') ?? rows[0])?.userId
}

/** An authenticated call, shaped the way the Lambda authorizer produces it. */
const authed = (method, path, body, ctx) => ({
  version: '2.0',
  rawPath: path,
  headers: { 'content-type': 'application/json', 'user-agent': 'makerbay-verify/1.0' },
  ...(body ? { body: JSON.stringify(body) } : {}),
  requestContext: {
    http: { method, path, sourceIp: '203.0.113.10' },
    authorizer: { lambda: ctx },
  },
})

/** A customer's browser: no authorizer at all, tenant resolved from the slug. */
const publicCall = (method, path, query, body) => ({
  version: '2.0',
  rawPath: path,
  queryStringParameters: query,
  headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone) verify' },
  ...(body ? { body: JSON.stringify(body) } : {}),
  requestContext: { http: { method, path, sourceIp: '203.0.113.55' }, authorizer: {} },
})

async function invoke(event) {
  const r = await lambda.send(new InvokeCommand({
    FunctionName: FN,
    Payload: Buffer.from(JSON.stringify(event)),
  }))
  const raw = JSON.parse(Buffer.from(r.Payload).toString('utf8'))
  if (raw?.errorType) throw new Error(`${raw.errorType}: ${raw.errorMessage}`)
  let data = {}
  try { data = JSON.parse(raw.body) } catch { /* non-JSON body */ }
  return { status: raw.statusCode, data }
}

const tenant = await tenantBySlug(SLUG)
if (!tenant) {
  console.error(`No tenant with slug "${SLUG}".`)
  process.exit(2)
}
const userId = await ownerUserId(tenant.tenantId)
if (!userId) {
  console.error(`Tenant "${SLUG}" has no users row, so there is nobody to act as.`)
  process.exit(2)
}
const ctx = { userId, tenantId: tenant.tenantId, scopes: '*' }
console.log(`tenant: ${tenant.name} (${SLUG})\nlambda: ${FN}\n`)

const PHONE = '0412 999 001'
const line = (cents) => [{ description: 'Verification line', unit: 'each', quantity: 1, unitCents: cents }]

// 1. A quote for someone with a phone number and NO email. Before issue 118
//    this could be created but never shared, because emailing was the only
//    way out of draft and the link stayed hidden until then.
const created = await invoke(authed('POST', '/v1/quotes', {
  customerName: 'Link Flow Check', customerPhone: PHONE, lines: line(12345),
}, ctx))
check('creates a quote with no email address', created.status === 201 || created.status === 200,
  `HTTP ${created.status} ${created.data?.error ?? ''}`)
const quote = created.data?.quote
if (!quote) { console.error('\nCannot continue without a quote.'); process.exit(1) }
const quoteId = quote.quoteId

// 2. Share it.
const shared = await invoke(authed('POST', `/v1/quotes/${quoteId}/share`, {}, ctx))
check('shares without sending anything', shared.status === 200, `HTTP ${shared.status} ${shared.data?.error ?? ''}`)
check('leaves draft on share', shared.data?.quote?.status === 'sent', `status=${shared.data?.quote?.status}`)
check('did not email', shared.data?.emailed === false)
const token = new URL(shared.data?.publicUrl ?? 'https://x/').searchParams.get('token')
check('hands back a link carrying the token', Boolean(token))

// 3. Open it as the customer: no sign-in of any kind.
const view = await invoke(publicCall('GET', `/v1/public/quotes/${token}`, { slug: SLUG }))
check('the customer can open it with no sign-in', view.status === 200, `HTTP ${view.status}`)
check('the gate is declared to the page', Boolean(view.data?.accept?.check), `check=${view.data?.accept?.check}`)
check('the affirmation names the amount', String(view.data?.accept?.affirmation ?? '').includes('123.45'),
  view.data?.accept?.affirmation)

// 4. The gate must not let a contract be recorded on a wrong answer.
const noName = await invoke(publicCall('POST', `/v1/public/quotes/${token}/respond`, { slug: SLUG },
  { slug: SLUG, decision: 'accept' }))
check('refuses to accept with no name typed', noName.status === 400,
  `HTTP ${noName.status} ${noName.data?.error ?? ''}`)

if (view.data?.accept?.check === 'phone4') {
  const badFour = await invoke(publicCall('POST', `/v1/public/quotes/${token}/respond`, { slug: SLUG },
    { slug: SLUG, decision: 'accept', name: 'Someone Else', phone4: '0000' }))
  check('refuses the wrong last four digits', badFour.status === 400,
    `HTTP ${badFour.status} ${badFour.data?.error ?? ''}`)
}

const stillOpen = await invoke(publicCall('GET', `/v1/public/quotes/${token}`, { slug: SLUG }))
check('a refused attempt records nothing', stillOpen.data?.quote?.status === 'sent',
  `status=${stillOpen.data?.quote?.status}`)

// 5. Accept properly.
const accepted = await invoke(publicCall('POST', `/v1/public/quotes/${token}/respond`, { slug: SLUG },
  { slug: SLUG, decision: 'accept', name: 'Link Flow Check', phone4: '9001' }))
check('accepts once the gate is satisfied', accepted.status === 200,
  `HTTP ${accepted.status} ${accepted.data?.error ?? accepted.data?.message ?? ''}`)

// 6. The acceptance record: what a dispute would actually ask for.
const row = await ddb.send(new GetCommand({
  TableName: 'makerbay-quotes', Key: { tenantId: tenant.tenantId, quoteId },
}))
const acc = row.Item?.acceptance
check('records the typed name as the signature', Boolean(acc?.name), acc?.name)
check('records the wording that was agreed to', Boolean(acc?.affirmation))
check('records the caller address', Boolean(acc?.ip), acc?.ip)
check('records a sha-256 document hash', /^[0-9a-f]{64}$/.test(acc?.documentHash ?? ''))
check('freezes the figures that were shown', acc?.snapshot?.totalCents === quote.totalCents,
  `snapshot=${acc?.snapshot?.totalCents} quote=${quote.totalCents}`)
check('records which check was satisfied', Boolean(acc?.check), acc?.check)
check('counted the customer opening it', (row.Item?.viewCount ?? 0) > 0, `viewCount=${row.Item?.viewCount}`)

// 7. Revocation, on a second quote: an accepted one is settled and keeps its link.
const second = await invoke(authed('POST', '/v1/quotes', {
  customerName: 'Revoke Check', customerPhone: PHONE, lines: line(5000),
}, ctx))
const secondId = second.data?.quote?.quoteId
const secondShare = await invoke(authed('POST', `/v1/quotes/${secondId}/share`, {}, ctx))
const oldToken = new URL(secondShare.data.publicUrl).searchParams.get('token')
check('the second link works before revoking',
  (await invoke(publicCall('GET', `/v1/public/quotes/${oldToken}`, { slug: SLUG }))).status === 200)

const revoked = await invoke(authed('POST', `/v1/quotes/${secondId}/revoke`, {}, ctx))
check('revoking succeeds', revoked.status === 200, `HTTP ${revoked.status} ${revoked.data?.error ?? ''}`)
const newToken = new URL(revoked.data.publicUrl).searchParams.get('token')
check('revoking mints a different token', newToken !== oldToken)
check('the OLD link stops working',
  (await invoke(publicCall('GET', `/v1/public/quotes/${oldToken}`, { slug: SLUG }))).status === 404)
check('the new link works',
  (await invoke(publicCall('GET', `/v1/public/quotes/${newToken}`, { slug: SLUG }))).status === 200)

// 8. A token must never resolve under a different tenant's slug.
check('a token does not resolve under another slug',
  (await invoke(publicCall('GET', `/v1/public/quotes/${newToken}`, { slug: 'baba-yaga' }))).status === 404)

// 9. A sent quote can no longer be silently re-priced.
const repriced = await invoke(authed('PATCH', `/v1/quotes/${secondId}`, { lines: line(999999) }, ctx))
check('refuses to re-price a quote already with the customer', repriced.status === 409,
  `HTTP ${repriced.status} ${repriced.data?.error ?? ''}`)

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
console.log(`\nThrowaway quotes to remove: ${quoteId}, ${secondId}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
