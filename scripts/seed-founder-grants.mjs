// Seed the founder's personal workspace with the operator comps that the
// demo tenant already carries: Presence Pro (custom domain gate) and full
// Genie. Run once: node scripts/seed-founder-grants.mjs
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }))
const tenantId = '01M0P42MP74XQYSM5XH4PWEZVG' // Aatral Arasu (aatrala@gmail.com)
const now = new Date().toISOString()

const grants = [
  {
    tenantId,
    sk: 'GRANT#presence#manual#01M0FNDRPRESENCEPRO0000001',
    moduleId: 'presence',
    planTier: 'pro',
    limits: {},
    status: 'active',
    source: 'manual',
    grantedBy: 'founder',
    reason: 'Founder workspace - Presence Pro for own custom domain',
    overage: 'block',
    createdAt: now,
    updatedAt: now,
  },
  {
    tenantId,
    sk: 'GRANT#genie#manual#01M0FNDRGENIEGRANT00000001',
    moduleId: 'genie',
    planTier: 'pro',
    limits: { genieMessagesPerMonth: 2500 },
    status: 'active',
    source: 'manual',
    grantedBy: 'founder',
    reason: 'Founder workspace - full Genie for daily use',
    overage: 'block',
    createdAt: now,
    updatedAt: now,
  },
]

for (const g of grants) {
  await ddb.send(new PutCommand({ TableName: 'makerbay-grants', Item: g }))
  console.log('seeded', g.sk)
}
