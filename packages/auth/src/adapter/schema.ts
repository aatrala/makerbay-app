import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb'

/**
 * The table this adapter expects, in the shape both CDK and a throwaway test
 * table can build from. Three GSIs, all projecting every attribute so a
 * lookup never needs a second read; TTL on `ttl`.
 *
 * Kept next to the adapter rather than in the stack so the tests and the
 * deployment cannot drift: `infra/lib/auth-stack.ts` reads the same
 * constants.
 */
export const GSI_NAMES = ['gsi1', 'gsi2', 'gsi3'] as const
export const TTL_ATTRIBUTE = 'ttl'

export function authTableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      ...GSI_NAMES.flatMap((g) => [
        { AttributeName: `${g}pk`, AttributeType: 'S' as const },
        { AttributeName: `${g}sk`, AttributeType: 'S' as const },
      ]),
    ],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: GSI_NAMES.map((g) => ({
      IndexName: g,
      KeySchema: [
        { AttributeName: `${g}pk`, KeyType: 'HASH' },
        { AttributeName: `${g}sk`, KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    })),
  }
}
