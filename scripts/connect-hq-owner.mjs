// Point a MakerBay sign-in at the MakerBay HQ workspace.
//
// HQ was seeded to power the assistant widget on makerbay.app and has never
// had a user, so nobody can open its diary. A `makerbay-users` row carries
// exactly one tenantId, which is why an existing account cannot simply be
// added to it - that would move the person off their own workspace.
//
// The thing that makes this fiddly: signing up creates a COGNITO user, but
// the DynamoDB user row is only written when onboarding completes. So there
// are three states to tell apart, and an earlier version of this script
// conflated the first two and reported "no account" to someone who had just
// made one:
//
//   1. no Cognito user            -> sign up first
//   2. Cognito user, no row       -> we can write the row straight at HQ,
//                                    which skips onboarding and creates no
//                                    throwaway workspace at all
//   3. row pointing somewhere else -> repoint it, and remove the throwaway
//                                    only if it is empty
//
// Run: node scripts/connect-hq-owner.mjs            (dry run, shows the plan)
//      node scripts/connect-hq-owner.mjs --apply    (makes the change)
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const REGION = 'us-east-1'
const HQ = '01M0T3STMAKERBAYHQ00000001'
const EMAIL = 'aatrala+mbhq@gmail.com'
const USER_POOL_ID = 'us-east-1_IkOWHdUNW'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))
const idp = new CognitoIdentityProviderClient({ region: REGION })
const apply = process.argv.includes('--apply')
const T = (n) => `makerbay-${n}`

async function findCognitoUser() {
  // Filter on email rather than listing everyone; the pool is small but this
  // stays correct as it grows.
  const r = await idp.send(new ListUsersCommand({
    UserPoolId: USER_POOL_ID,
    Filter: `email = "${EMAIL}"`,
    Limit: 5,
  }))
  const u = (r.Users ?? [])[0]
  if (!u) return undefined
  const sub = (u.Attributes ?? []).find((a) => a.Name === 'sub')?.Value
  return { sub, username: u.Username, status: u.UserStatus, confirmed: u.UserStatus === 'CONFIRMED' }
}

async function main() {
  const cognito = await findCognitoUser()
  if (!cognito) {
    console.log(`No Cognito user for ${EMAIL}.`)
    console.log('Sign up at https://app.makerbay.app with that address, then run this again.')
    return
  }
  console.log(`cognito   ${EMAIL}  sub ${cognito.sub}  status ${cognito.status}`)
  if (!cognito.confirmed) {
    console.log('\nThat account has not confirmed its email yet. Enter the six-digit code')
    console.log('from your inbox to finish signing up, then run this again.')
    return
  }

  const existing = await ddb.send(new GetCommand({
    TableName: T('users'), Key: { userId: cognito.sub },
  }))
  const row = existing.Item

  // State 2: signed up but never finished onboarding. Writing the row
  // ourselves points them straight at HQ and skips onboarding entirely, so
  // no throwaway workspace is ever created.
  if (!row) {
    console.log('no workspace row yet -> will create one pointing straight at HQ')
    console.log('(this skips onboarding, so no throwaway workspace is made)')
    if (!apply) return console.log('\nDry run. Re-run with --apply to make the change.')
    await ddb.send(new PutCommand({
      TableName: T('users'),
      Item: {
        userId: cognito.sub,
        email: EMAIL,
        tenantId: HQ,
        role: 'owner',
        createdAt: new Date().toISOString(),
      },
      ConditionExpression: 'attribute_not_exists(userId)',
    }))
    console.log('\nDone. Sign in at https://app.makerbay.app and you will land in MakerBay HQ.')
    return
  }

  // State 3: already has a workspace.
  if (row.tenantId === HQ) {
    console.log(`\n${EMAIL} already owns MakerBay HQ. Nothing to do.`)
    return
  }

  const old = await ddb.send(new GetCommand({
    TableName: T('tenants'), Key: { tenantId: row.tenantId },
  }))
  const count = async (table) =>
    ddb.send(new QueryCommand({
      TableName: T(table),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': row.tenantId },
      Select: 'COUNT',
    })).then((r) => r.Count ?? 0).catch(() => 0)
  const [contacts, bookings] = await Promise.all([count('contacts'), count('bookings')])
  // Never delete a workspace with anything in it. An onboarding throwaway is
  // empty; anything else is somebody's real work.
  const empty = contacts === 0 && bookings === 0

  console.log(`currently ${row.tenantId}  "${old.Item?.name ?? '(unknown)'}"`)
  console.log(`moving to ${HQ}  "MakerBay HQ"`)
  console.log(`old workspace: ${contacts} contacts, ${bookings} bookings -> ${empty ? 'safe to remove' : 'KEEPING, it has content'}`)
  if (!apply) return console.log('\nDry run. Re-run with --apply to make the change.')

  await ddb.send(new UpdateCommand({
    TableName: T('users'),
    Key: { userId: row.userId },
    UpdateExpression: 'SET tenantId = :hq',
    ExpressionAttributeValues: { ':hq': HQ },
  }))
  console.log('\nuser repointed at HQ')
  if (empty) {
    await ddb.send(new DeleteCommand({ TableName: T('tenants'), Key: { tenantId: row.tenantId } }))
    console.log('empty throwaway workspace removed')
  }
  console.log('\nSign out and back in at https://app.makerbay.app to land in HQ.')
}

main().catch((err) => {
  if (String(err?.name) === 'ExpiredTokenException' || /expired/i.test(String(err?.message))) {
    console.error('AWS session has expired. Run `aws login`, then try again.')
    process.exit(1)
  }
  console.error(err)
  process.exit(1)
})
