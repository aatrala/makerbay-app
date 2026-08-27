// Make the $99 setup session bookable from the MakerBay HQ workspace.
//
// The session is sold as an ordinary booking, through the same diary and
// deposit flow any tradie's customer uses (docs/spec-concierge.md phase 3).
// That is why it needs no payment code: MakerBay already knows how to sell a
// booked slot.
//
// HQ was seeded to power the assistant widget on makerbay.app and has never
// had booking data, so /p/makerbay-hq renders with nothing bookable on it.
// This writes the two rows that fix that.
//
// Run once: node scripts/seed-hq-session.mjs
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }))
const tenantId = '01M0T3STMAKERBAYHQ00000001' // MakerBay HQ, slug makerbay-hq
const now = new Date().toISOString()

// Until HQ has a dashboard login of its own, the booking notification is the
// only way a human hears about a sale. Point it at a mailbox someone reads.
const NOTIFY = 'aatrala+mbhq@gmail.com'

const config = {
  tenantId,
  timezone: 'Australia/Sydney',
  // Weekday afternoons only. A session is 45 minutes of someone's full
  // attention, so the diary should not imply unlimited availability.
  hours: {
    mon: [{ from: '13:00', to: '17:00' }],
    tue: [{ from: '13:00', to: '17:00' }],
    wed: [{ from: '13:00', to: '17:00' }],
    thu: [{ from: '13:00', to: '17:00' }],
    fri: [{ from: '13:00', to: '17:00' }],
  },
  // A day's notice, so a booking never lands before it can be prepared for.
  leadTimeHours: 24,
  horizonDays: 45,
  closures: [],
  notifyEmail: NOTIFY,
  intro: 'Pick a time and we will set your workspace up together, on your screen.',
}

const service = {
  tenantId,
  serviceId: '01M0SETUPSESSION0000000001',
  name: 'Setup session, 45 minutes',
  description:
    'We set your page, your assistant, your services and your diary up together, on your screen, '
    + 'including the parts that are not in MakerBay at all. Refunded in full if we do not finish '
    + 'what we agreed.',
  durationMinutes: 45,
  // Fifteen minutes between sessions: notes from the last one, prep for the next.
  bufferMinutes: 15,
  priceCents: 9900,
  // Deposit taken up front. A booked hour of a person's time that nobody turns
  // up for is the one thing this cannot absorb.
  depositCents: 9900,
  active: true,
  createdAt: now,
}

const T = (name) => `makerbay-${name}`

async function main() {
  const existingConfig = await ddb.send(new GetCommand({
    TableName: T('bookingconfig'), Key: { tenantId },
  }))
  if (existingConfig.Item) {
    console.log('booking config already exists on HQ; leaving it alone')
  } else {
    await ddb.send(new PutCommand({ TableName: T('bookingconfig'), Item: config }))
    console.log('booking config written:', config.timezone, Object.keys(config.hours).join(' '))
  }

  const existingServices = await ddb.send(new QueryCommand({
    TableName: T('bookingservices'),
    KeyConditionExpression: 'tenantId = :t',
    ExpressionAttributeValues: { ':t': tenantId },
  }))
  const already = (existingServices.Items ?? []).find((s) => s.serviceId === service.serviceId)
  if (already) {
    console.log('session service already exists; leaving it alone')
  } else {
    await ddb.send(new PutCommand({ TableName: T('bookingservices'), Item: service }))
    console.log('service written:', service.name, `$${service.priceCents / 100}`)
  }

  console.log('\nBookable at https://makerbay.app/p/makerbay-hq')
  console.log(`Booking notifications go to ${NOTIFY}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
