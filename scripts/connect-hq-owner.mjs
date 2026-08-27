// Point an existing MakerBay sign-in at the MakerBay HQ workspace.
//
// HQ was seeded to power the assistant widget on makerbay.app and has never
// had a user, so nobody can open its diary. A user row carries exactly one
// tenantId, which is why an existing account cannot simply be added to it -
// doing that would move the person off their own workspace.
//
// So the sequence is: sign up normally at app.makerbay.app with the address
// below (you set your own password, nobody else ever holds it), let
// onboarding create a throwaway workspace, then run this. It repoints the
// user at HQ and offers to remove the throwaway.
//
// Run: node scripts/connect-hq-owner.mjs            (dry run, shows the plan)
//      node scripts/connect-hq-owner.mjs --apply    (makes the change)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }))
const HQ = '01M0T3STMAKERBAYHQ00000001'
const EMAIL = 'aatrala+mbhq@gmail.com'
const apply = process.argv.includes('--apply')

const T = (n) => `makerbay-${n}`

async function main() {
  const users = await ddb.send(new ScanCommand({
    TableName: T('users'),
    FilterExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': EMAIL },
  }))
  const user = (users.Items ?? [])[0]
  if (!user) {
    console.log(`No account for ${EMAIL} yet.`)
    console.log('Sign up at https://app.makerbay.app with that address first, then run this again.')
    return
  }
  if (user.tenantId === HQ) {
    console.log(`${EMAIL} is already the owner of MakerBay HQ. Nothing to do.`)
    return
  }

  const old = await ddb.send(new GetCommand({
    TableName: T('tenants'), Key: { tenantId: user.tenantId },
  }))
  const oldName = old.Item?.name ?? '(unknown)'

  // Never delete a workspace that has anything in it. The throwaway from
  // onboarding is empty; anything else is somebody's real work.
  const [contacts, bookings] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: T('contacts'),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': user.tenantId },
      Select: 'COUNT',
    })).then((r) => r.Count ?? 0).catch(() => 0),
    ddb.send(new QueryCommand({
      TableName: T('bookings'),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': user.tenantId },
      Select: 'COUNT',
    })).then((r) => r.Count ?? 0).catch(() => 0),
  ])
  const empty = contacts === 0 && bookings === 0

  console.log(`user      ${EMAIL} (${user.userId})`)
  console.log(`currently ${user.tenantId}  "${oldName}"`)
  console.log(`moving to ${HQ}  "MakerBay HQ"`)
  console.log(`old workspace: ${contacts} contacts, ${bookings} bookings -> ${empty ? 'safe to remove' : 'KEEPING, it has content'}`)

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to make the change.')
    return
  }

  await ddb.send(new UpdateCommand({
    TableName: T('users'),
    Key: { userId: user.userId },
    UpdateExpression: 'SET tenantId = :hq',
    ExpressionAttributeValues: { ':hq': HQ },
  }))
  console.log('\nuser repointed at HQ')

  if (empty) {
    await ddb.send(new DeleteCommand({ TableName: T('tenants'), Key: { tenantId: user.tenantId } }))
    console.log('empty throwaway workspace removed')
  } else {
    console.log('old workspace left in place, it has content')
  }
  console.log('\nSign out and back in at https://app.makerbay.app to land in HQ.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
