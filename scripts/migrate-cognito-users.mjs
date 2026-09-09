#!/usr/bin/env node
/**
 * Give every existing customer a Better Auth identity (issue 157).
 *
 * For each row in the Users table - keyed by the Cognito `sub` - this writes
 * two rows into the auth table:
 *
 *   user     id = sub, email, emailVerified = true
 *   account  providerId = 'cognito', accountId = sub, userId = sub
 *
 * The user id IS the Cognito sub on purpose: the Lambda authorizer keys the
 * Users table by whatever `sub` the token carries, so keeping the id means
 * no row anywhere is re-keyed. The account row is what lets "sign in with
 * your MakerBay password" (the Cognito upstream) find this user instead of
 * creating a second one.
 *
 * Idempotent and dry by default. Writes are conditional on the row not
 * existing, so re-running never overwrites a user who has since signed in
 * and changed something.
 *
 *   node scripts/migrate-cognito-users.mjs            # report only
 *   node scripts/migrate-cognito-users.mjs --write    # do it
 *
 * The item shape below mirrors packages/auth/src/adapter/keys.ts. It is
 * duplicated here rather than imported because this is a plain .mjs script
 * and the adapter is TypeScript; the adapter's own tests pin the shape, and
 * the first upstream sign-in after running this proves the account lookup.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'

const REGION = process.env.AWS_REGION ?? 'us-east-1'
const USERS = process.env.TABLE_USERS ?? 'makerbay-users'
const AUTH = process.env.TABLE_AUTH ?? 'makerbay-auth'
const WRITE = process.argv.includes('--write')

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
})

/** Adapter-owned attributes; see internalAttrs in keys.ts. */
const attrs = (model, item, gsi1, gsi2) => ({
  pk: `${model}#${item.id}`,
  _model: model,
  gsi3pk: model,
  gsi3sk: item.createdAt,
  ...(gsi1 ? { gsi1pk: gsi1, gsi1sk: item.createdAt } : {}),
  ...(gsi2 ? { gsi2pk: gsi2, gsi2sk: item.createdAt } : {}),
})

export function itemsFor(user) {
  const sub = user.userId
  const email = String(user.email ?? '').trim()
  const createdAt = user.createdAt ?? new Date().toISOString()
  const lower = email.toLowerCase()
  const u = { id: sub, email, emailVerified: true, name: email.split('@')[0] ?? '', createdAt, updatedAt: createdAt }
  const a = { id: sub, accountId: sub, providerId: 'cognito', userId: sub, createdAt, updatedAt: createdAt }
  return [
    { ...u, ...attrs('user', u, `user#email#${lower}`) },
    { pk: `unique#user#email#${lower}`, _model: 'unique', userId: sub },
    { ...a, ...attrs('account', a, `account#providerId#cognito#accountId#${sub}`, `account#userId#${sub}`) },
  ]
}

async function main() {
  const users = []
  let ExclusiveStartKey
  do {
    const r = await ddb.send(new ScanCommand({ TableName: USERS, ExclusiveStartKey }))
    users.push(...(r.Items ?? []))
    ExclusiveStartKey = r.LastEvaluatedKey
  } while (ExclusiveStartKey)

  console.log(`${users.length} user rows in ${USERS}; mode: ${WRITE ? 'WRITE' : 'dry run'}`)
  let done = 0
  let skipped = 0
  for (const user of users) {
    if (!user.userId || !user.email?.includes('@')) {
      console.log(`skip  ${user.userId ?? '?'}: no email on the row`)
      skipped++
      continue
    }
    const items = itemsFor(user)
    const masked = user.email.replace(/^(.).*(@.*)$/, '$1***$2')
    if (!WRITE) {
      console.log(`would write  user ${user.userId} ${masked} (+ account, + email marker)`)
      continue
    }
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: items.map((Item) => ({
          Put: { TableName: AUTH, Item, ConditionExpression: 'attribute_not_exists(pk)' },
        })),
      }))
      console.log(`wrote  user ${user.userId} ${masked}`)
      done++
    } catch (err) {
      if (err.name === 'TransactionCanceledException') {
        console.log(`exists ${user.userId} ${masked} - left alone`)
        skipped++
      } else {
        throw err
      }
    }
  }
  console.log(`\n${WRITE ? `${done} written, ${skipped} skipped` : 'dry run complete - add --write to apply'}`)
}

// Only run when invoked directly, so the test can import itemsFor.
if (process.argv[1] && /migrate-cognito-users\.mjs$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
