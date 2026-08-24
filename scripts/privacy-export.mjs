// Privacy export (G7): every row this tenant owns, across every table,
// into one JSON file - the "give me my data" half of a privacy request.
//
//   AWS_PROFILE=makerbay node scripts/privacy-export.mjs <tenantId>
//
// Cognito user attributes and Stripe records are NOT here - export those
// by hand from their consoles, and note the request in the staff audit
// log (a grant note works as a record until the console grows a field).
import { writeFileSync } from 'node:fs'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'

const tenantId = process.argv[2]
if (!/^[0-9A-Z]{26}$/.test(tenantId ?? '')) {
  console.error('Usage: node scripts/privacy-export.mjs <tenantId (ULID)>')
  process.exit(1)
}

const region = 'us-east-1'
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }))
const s3 = new S3Client({ region })

const raw = new DynamoDBClient({ region })
const { ListTablesCommand } = await import('@aws-sdk/client-dynamodb')
const tables = (await raw.send(new ListTablesCommand({}))).TableNames.filter((t) => t.startsWith('makerbay-'))

/** A row belongs to the tenant when any of its id-shaped fields says so. */
const owns = (item) =>
  item.tenantId === tenantId ||
  (typeof item.pk === 'string' && item.pk.startsWith(tenantId)) ||
  (typeof item.targetTenantId === 'string' && item.targetTenantId === tenantId)

const out = { tenantId, exportedAt: new Date().toISOString(), tables: {}, knowledgeObjects: [] }
let total = 0

for (const table of tables) {
  const rows = []
  let key
  do {
    const r = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }))
    for (const item of r.Items ?? []) if (owns(item)) rows.push(item)
    key = r.LastEvaluatedKey
  } while (key)
  if (rows.length) {
    out.tables[table] = rows
    total += rows.length
    console.log(`${table}: ${rows.length} rows`)
  }
}

// Knowledge documents live under the tenant's prefix in the knowledge bucket.
const bucket = `makerbay-knowledge-953146692138`
try {
  let token
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${tenantId}/`, ContinuationToken: token }))
    for (const o of r.Contents ?? []) out.knowledgeObjects.push({ key: o.Key, size: o.Size })
    token = r.NextContinuationToken
  } while (token)
  console.log(`knowledge bucket: ${out.knowledgeObjects.length} objects (listed, not embedded)`)
} catch (err) {
  console.warn('knowledge bucket listing skipped:', err.name)
}

const file = `privacy-export-${tenantId}-${new Date().toISOString().slice(0, 10)}.json`
writeFileSync(file, JSON.stringify(out, null, 2))
console.log(`\n${total} rows written to ${file}`)
console.log('Remember, by hand: Cognito user attributes, Stripe customer data, and an audit note.')
