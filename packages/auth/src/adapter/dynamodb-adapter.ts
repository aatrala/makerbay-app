import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import { createAdapterFactory, type CleanedWhere, type DBAdapterDebugLogOption } from 'better-auth/adapters'
import { INTERNAL, emailMarkerPk, internalAttrs, pkOf } from './keys'
import { matches, plan, sortRows, type Plan } from './where'

/**
 * Better Auth on DynamoDB (issue 157).
 *
 * Built with Better Auth's `createAdapterFactory`, which owns id generation,
 * date and JSON coercion, default values, joins (done for us in memory) and
 * the where-clause normalisation. What is left for this file is the wire:
 * one table, three indexes, and the ten operations below.
 *
 * Decisions worth knowing before changing anything:
 * - **Reads are planned, filters run in memory.** See where.ts. One
 *   evaluator, the memory adapter's semantics, no expression syntax.
 * - **Uniqueness is enforced for `user.email` with a marker item** written
 *   in the same transaction as the user. A GSI cannot enforce uniqueness,
 *   and two sign-ups racing on one address must not produce two users.
 *   Session tokens are 32+ random bytes; a marker for them buys nothing.
 * - **`update` is a conditional Put of the merged row**, not a SET list.
 *   Every indexed attribute is recomputed from the merged row, so an update
 *   can never leave a stale index pointer. Last writer wins on the same row,
 *   which is what every Better Auth adapter does.
 * - **No transactions across operations** (`transaction: false`). Better
 *   Auth runs the steps sequentially, as its docs allow.
 */

export interface DynamoAdapterConfig {
  client: DynamoDBDocumentClient
  tableName: string
  debugLogs?: DBAdapterDebugLogOption
}

type Row = Record<string, unknown>

const isConditionFailure = (err: unknown): boolean => {
  const name = (err as { name?: string })?.name ?? ''
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException'
}

export const dynamoAdapter = (cfg: DynamoAdapterConfig) =>
  createAdapterFactory({
    config: {
      adapterId: 'dynamodb',
      adapterName: 'DynamoDB Adapter',
      usePlural: false,
      debugLogs: cfg.debugLogs ?? false,
      supportsJSON: false,
      supportsDates: false,
      supportsBooleans: true,
      supportsNumericIds: false,
      supportsArrays: false,
      transaction: false,
    },
    adapter: ({ getDefaultFieldName, getFieldName }) => {
      const { client, tableName: TableName } = cfg

      const idField = (model: string) => getFieldName({ model, field: 'id' })

      /** The row as Better Auth wants it back: no adapter-owned attributes. */
      const strip = (item: Row): Row => {
        const out: Row = {}
        for (const [k, v] of Object.entries(item)) if (!INTERNAL.has(k)) out[k] = v
        return out
      }

      const project = (row: Row, model: string, select?: string[]): Row => {
        if (!select?.length) return row
        const out: Row = {}
        for (const [k, v] of Object.entries(row)) {
          if (select.includes(getDefaultFieldName({ model, field: k }))) out[k] = v
        }
        return out
      }

      // ── Reads ──────────────────────────────────────────────────────

      async function execute(p: Plan): Promise<Row[]> {
        if (p.kind === 'get') {
          const r = await client.send(new GetCommand({ TableName, Key: { pk: p.pk } }))
          return r.Item ? [r.Item] : []
        }
        if (p.kind === 'batchGet') {
          const out: Row[] = []
          for (let i = 0; i < p.pks.length; i += 100) {
            let keys = p.pks.slice(i, i + 100).map((pk) => ({ pk }))
            while (keys.length) {
              const r = await client.send(new BatchGetCommand({ RequestItems: { [TableName]: { Keys: keys } } }))
              out.push(...((r.Responses?.[TableName] ?? []) as Row[]))
              keys = (r.UnprocessedKeys?.[TableName]?.Keys ?? []) as Array<{ pk: string }>
            }
          }
          return out
        }
        const out: Row[] = []
        let ExclusiveStartKey: Row | undefined
        do {
          const r = await client.send(new QueryCommand({
            TableName,
            IndexName: p.index,
            KeyConditionExpression: '#pk = :pk',
            ExpressionAttributeNames: { '#pk': `${p.index}pk` },
            ExpressionAttributeValues: { ':pk': p.pk },
            ExclusiveStartKey,
          }))
          out.push(...((r.Items ?? []) as Row[]))
          ExclusiveStartKey = r.LastEvaluatedKey as Row | undefined
        } while (ExclusiveStartKey)
        return out
      }

      /** Every row of `model` matching `where`, before sort and pagination. */
      async function find(model: string, where: CleanedWhere[] | undefined): Promise<Row[]> {
        const p = plan(model, where, idField(model))
        const rows = await execute(p)
        // A key read narrows to the model already; the model partition is the
        // model by construction. The `_model` check is belt and braces for a
        // GetItem on an id that happens to collide across models.
        return rows.filter((r) => r._model === model && matches(r, p.residue))
      }

      // ── Writes ─────────────────────────────────────────────────────

      /** Write a row, keeping the email marker in step for users. */
      async function put(model: string, row: Row, previous?: Row): Promise<void> {
        const item = { ...row, ...internalAttrs(model, row) }
        const isUser = model === 'user'
        const newEmail = isUser && typeof row.email === 'string' ? row.email : undefined
        const oldEmail = isUser && typeof previous?.email === 'string' ? previous.email : undefined
        const emailChanged = (newEmail ?? '').toLowerCase() !== (oldEmail ?? '').toLowerCase()

        if (!isUser || !emailChanged) {
          await client.send(new PutCommand({
            TableName,
            Item: item,
            ...(previous ? { ConditionExpression: 'attribute_exists(pk)' } : {}),
          }))
          return
        }
        const items: Array<Record<string, unknown>> = [
          { Put: { TableName, Item: item, ...(previous ? { ConditionExpression: 'attribute_exists(pk)' } : {}) } },
        ]
        if (newEmail) {
          items.push({
            Put: {
              TableName,
              Item: { pk: emailMarkerPk(newEmail), _model: 'unique', userId: row.id },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          })
        }
        if (oldEmail) items.push({ Delete: { TableName, Key: { pk: emailMarkerPk(oldEmail) } } })
        try {
          await client.send(new TransactWriteCommand({ TransactItems: items as never }))
        } catch (err) {
          if (isConditionFailure(err)) {
            throw new Error(`A user with the email ${String(newEmail)} already exists`)
          }
          throw err
        }
      }

      async function remove(model: string, row: Row): Promise<void> {
        await client.send(new DeleteCommand({ TableName, Key: { pk: pkOf(model, row.id) } }))
        if (model === 'user' && typeof row.email === 'string') {
          await client.send(new DeleteCommand({ TableName, Key: { pk: emailMarkerPk(row.email) } }))
        }
      }

      return {
        create: async ({ model, data }) => {
          await put(model, data as Row)
          return data
        },

        findOne: async ({ model, where, select }) => {
          const rows = await find(model, where)
          const first = rows[0]
          return first ? (project(strip(first), model, select) as never) : null
        },

        findMany: async ({ model, where, limit, sortBy, offset, select }) => {
          let rows = sortRows(await find(model, where), sortBy)
          if (offset !== undefined) rows = rows.slice(offset)
          if (limit !== undefined) rows = rows.slice(0, limit)
          return rows.map((r) => project(strip(r), model, select)) as never
        },

        count: async ({ model, where }) => (await find(model, where)).length,

        update: async ({ model, where, update }) => {
          if (where.length === 0) return null
          const current = (await find(model, where))[0]
          if (!current) return null
          const previous = strip(current)
          const merged = { ...previous, ...(update as Row) }
          await put(model, merged, previous)
          return merged as never
        },

        updateMany: async ({ model, where, update }) => {
          const rows = await find(model, where)
          for (const r of rows) {
            const previous = strip(r)
            await put(model, { ...previous, ...(update as Row) }, previous)
          }
          return rows.length
        },

        delete: async ({ model, where }) => {
          if (where.length === 0) return
          const row = (await find(model, where))[0]
          if (row) await remove(model, strip(row))
        },

        deleteMany: async ({ model, where }) => {
          const rows = await find(model, where)
          const keys = rows.flatMap((r) => {
            const out = [{ pk: pkOf(model, r.id) }]
            if (model === 'user' && typeof r.email === 'string') out.push({ pk: emailMarkerPk(r.email) })
            return out
          })
          for (let i = 0; i < keys.length; i += 25) {
            let batch = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }))
            while (batch.length) {
              const r = await client.send(new BatchWriteCommand({ RequestItems: { [TableName]: batch } }))
              batch = (r.UnprocessedItems?.[TableName] ?? []) as typeof batch
            }
          }
          return rows.length
        },

        /**
         * Single-use consumption: the row is deleted only if it still exists
         * at the moment of deletion, so two concurrent consumers of one
         * token get exactly one success.
         */
        consumeOne: async ({ model, where }) => {
          const row = (await find(model, where))[0]
          if (!row) return null
          try {
            const r = await client.send(new DeleteCommand({
              TableName,
              Key: { pk: pkOf(model, row.id) },
              ConditionExpression: 'attribute_exists(pk)',
              ReturnValues: 'ALL_OLD',
            }))
            return r.Attributes ? (strip(r.Attributes) as never) : null
          } catch (err) {
            if (isConditionFailure(err)) return null
            throw err
          }
        },

        /**
         * Guarded counter: the `where` is re-checked as a condition on the
         * write itself, so a rate-limit window that rolled over between the
         * read and the write is not double-counted.
         */
        incrementOne: async ({ model, where, increment, set }) => {
          const row = (await find(model, where))[0]
          if (!row) return null
          const names: Record<string, string> = {}
          const values: Record<string, unknown> = {}
          const adds: string[] = []
          const sets: string[] = []
          let n = 0
          const alias = (field: string) => {
            const k = `#f${n}`
            names[k] = field
            return k
          }
          for (const [field, delta] of Object.entries(increment)) {
            const k = alias(field)
            values[`:d${n}`] = delta
            adds.push(`${k} :d${n}`)
            n++
          }
          for (const [field, value] of Object.entries(set ?? {})) {
            const k = alias(field)
            values[`:s${n}`] = value
            sets.push(`${k} = :s${n}`)
            n++
          }
          // The guard: every clause of the where, ANDed, on the row's current
          // values. Only the operators a condition expression can carry; the
          // read above already applied the rest.
          const guards: string[] = ['attribute_exists(pk)']
          for (const w of where) {
            const k = alias(w.field)
            const v = `:g${n}`
            n++
            const map: Record<string, string> = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }
            const op = map[w.operator]
            if (!op || w.value === null || Array.isArray(w.value)) continue
            values[v] = w.value
            guards.push(`${k} ${op} ${v}`)
          }
          const expr = [adds.length ? `ADD ${adds.join(', ')}` : '', sets.length ? `SET ${sets.join(', ')}` : '']
            .filter(Boolean)
            .join(' ')
          try {
            const r = await client.send(new UpdateCommand({
              TableName,
              Key: { pk: pkOf(model, row.id) },
              UpdateExpression: expr,
              ConditionExpression: guards.join(' AND '),
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
              ReturnValues: 'ALL_NEW',
            }))
            const updated = r.Attributes ? strip(r.Attributes) : null
            // A `set` that touched an indexed field needs the index recomputed.
            if (updated && set && Object.keys(set).length) await put(model, updated, updated)
            return updated as never
          } catch (err) {
            if (isConditionFailure(err)) return null
            throw err
          }
        },
      }
    },
  })
