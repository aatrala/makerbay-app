// Privacy delete (G7): permanently removes every row and knowledge object
// this tenant owns. Run privacy-export first - this is irreversible.
//
//   AWS_PROFILE=makerbay node scripts/privacy-delete.mjs <tenantId> --confirm <tenantId>
//
// The doubled tenant id is deliberate: pasting the wrong workspace id once
// should not be enough to destroy it. Cognito users and Stripe customers
// are deleted by hand afterwards, and the action noted in the audit log.
import { DynamoDBClient, DescribeTableCommand, ListTablesCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'

const tenantId = process.argv[2]
const confirmFlag = process.argv[3]
const confirmValue = process.argv[4]
if (!/^[0-9A-Z]{26}$/.test(tenantId ?? '') || confirmFlag !== '--confirm' || confirmValue !== tenantId) {
  console.error('Usage: node scripts/privacy-delete.mjs <tenantId> --confirm <same tenantId>')
  process.exit(1)
}

const region = 'us-east-1'
const raw = new DynamoDBClient({ region })
const ddb = DynamoDBDocumentClient.from(raw)
const s3 = new S3Client({ region })

const tables = (await raw.send(new ListTablesCommand({}))).TableNames.filter((t) => t.startsWith('makerbay-'))
// The third test is not decoration. Unsubscribe tokens are stored in MailLog
// under a RESERVED partition - tenantId is the literal string 'unsub-token'
// and the owning workspace is in `forTenant` - so a row holding a customer's
// email address matched neither of the first two tests and survived a delete
// that reported success. See packages/core/src/unsubscribe.ts.
const owns = (item) =>
  item.tenantId === tenantId
  || (typeof item.pk === 'string' && item.pk.startsWith(tenantId))
  || item.forTenant === tenantId

let deleted = 0

/*
 * The auth table first, while the Users rows still exist to say who the
 * people were (issue 158). Its rows carry no tenantId - the key is
 * `<model>#<id>` - so the generic pass below cannot see them, and until this
 * pass existed a delete reported success and left every sign-in identity
 * behind. For each person: the user row, their accounts, sessions and
 * passkeys (indexed by user on gsi2), the verification rows for their
 * address, invitations to that address anywhere, and the email uniqueness
 * marker - which, left behind, would block that address from ever signing
 * up again.
 */
{
  const AUTH = 'makerbay-auth'
  const people = []
  let key
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: 'makerbay-users',
      FilterExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
      ExclusiveStartKey: key,
    }))
    people.push(...(r.Items ?? []))
    key = r.LastEvaluatedKey
  } while (key)

  const del = async (pk) => { await ddb.send(new DeleteCommand({ TableName: AUTH, Key: { pk } })); deleted++ }
  const byIndex = async (index, pkValue) => {
    const out = []
    let k
    do {
      const r = await ddb.send(new QueryCommand({
        TableName: AUTH, IndexName: index,
        KeyConditionExpression: `${index}pk = :p`, ExpressionAttributeValues: { ':p': pkValue },
        ExclusiveStartKey: k,
      }))
      out.push(...(r.Items ?? []))
      k = r.LastEvaluatedKey
    } while (k)
    return out
  }

  let authRows = 0
  for (const person of people) {
    const id = person.userId
    const email = String(person.email ?? '').trim().toLowerCase()
    for (const model of ['session', 'account', 'passkey', 'member']) {
      for (const row of await byIndex('gsi2', `${model}#userId#${id}`)) { await del(row.pk); authRows++ }
    }
    if (email) {
      for (const row of await byIndex('gsi3', 'verification')) {
        if (String(row.identifier ?? '').toLowerCase().includes(email)) { await del(row.pk); authRows++ }
      }
      for (const row of await byIndex('gsi2', `invitation#email#${email}`)) { await del(row.pk); authRows++ }
      await del(`unique#user#email#${email}`); authRows++
    }
    await del(`user#${id}`); authRows++
  }
  if (authRows) console.log(`${AUTH}: deleted ${authRows} rows for ${people.length} people`)
}

for (const table of tables) {
  // The staff audit trail is append-only BY DESIGN - privacy deletion of
  // audit entries about the tenant is a legal-review call, not a default.
  if (table === 'makerbay-adminaudit') continue
  const desc = await raw.send(new DescribeTableCommand({ TableName: table }))
  const keyAttrs = desc.Table.KeySchema.map((k) => k.AttributeName)

  let key
  let count = 0
  do {
    const r = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }))
    for (const item of r.Items ?? []) {
      if (!owns(item)) continue
      const itemKey = Object.fromEntries(keyAttrs.map((a) => [a, item[a]]))
      await ddb.send(new DeleteCommand({ TableName: table, Key: itemKey }))
      count++
    }
    key = r.LastEvaluatedKey
  } while (key)
  if (count) {
    deleted += count
    console.log(`${table}: deleted ${count}`)
  }
}

const bucket = `makerbay-knowledge-953146692138`
try {
  let token
  let objs = 0
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${tenantId}/`, ContinuationToken: token }))
    const keys = (r.Contents ?? []).map((o) => ({ Key: o.Key }))
    if (keys.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }))
      objs += keys.length
    }
    token = r.NextContinuationToken
  } while (token)
  console.log(`knowledge bucket: deleted ${objs} objects`)
} catch (err) {
  console.warn('knowledge bucket cleanup skipped:', err.name)
}

console.log(`\nDone: ${deleted} rows removed for ${tenantId}.`)
console.log('Finish by hand: delete any Cognito user(s) that still exist, the Stripe customer, and add an audit note.')
