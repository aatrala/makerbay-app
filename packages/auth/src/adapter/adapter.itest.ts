import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { authFlowTestSuite, normalTestSuite, testAdapter } from '@better-auth/test-utils/adapter'
import { dynamoAdapter } from './dynamodb-adapter'
import { authTableDefinition } from './schema'

/**
 * Better Auth's own adapter conformance suites, run against a real DynamoDB
 * table (issue 157). Not part of `npm test` - it needs a database. Run with
 * `npm run test:adapter`.
 *
 * Where the table lives is an environment decision:
 *   AUTH_TEST_ENDPOINT=http://localhost:8000   → DynamoDB Local in Docker
 *   (unset)                                     → a throwaway table in the
 *                                                 account behind AWS_PROFILE,
 *                                                 created here, deleted at the end.
 * The suites create and delete a few hundred rows; on-demand billing makes
 * that cents.
 */
const endpoint = process.env.AUTH_TEST_ENDPOINT
const tableName = process.env.AUTH_TEST_TABLE ?? `makerbay-auth-test-${process.pid}`

const raw = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(endpoint
    ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
    : {}),
})
const client = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } })

const { execute } = await testAdapter({
  adapter: () => dynamoAdapter({ client, tableName }),
  runMigrations: async () => {
    try {
      await raw.send(new CreateTableCommand(authTableDefinition(tableName)))
    } catch (err) {
      if ((err as { name?: string }).name !== 'ResourceInUseException') throw err
    }
    await waitUntilTableExists({ client: raw, maxWaitTime: 120 }, { TableName: tableName })
  },
  tests: [normalTestSuite(), authFlowTestSuite()],
  onFinish: async () => {
    if (process.env.AUTH_TEST_KEEP) return
    await raw.send(new DeleteTableCommand({ TableName: tableName }))
  },
})

execute()
