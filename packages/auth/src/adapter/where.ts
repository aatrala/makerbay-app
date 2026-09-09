import type { CleanedWhere } from 'better-auth/adapters'
import { INDEXES, isEmailField, keyValue, pkOf } from './keys'

/**
 * Turns a Better Auth `where` into the cheapest DynamoDB read that can
 * satisfy it, then applies whatever is left in memory (issue 157).
 *
 * Three shapes, tried in order:
 *  1. `id = x`            → GetItem
 *  2. `id in [...]`       → BatchGetItem
 *  3. every field of a GSI key present as `eq`
 *                         → Query that GSI
 *  4. anything else       → Query the model partition
 *
 * The residue - every clause the key did not consume - is evaluated in
 * memory with exactly the semantics of Better Auth's own memory adapter,
 * including its left-to-right AND/OR chaining. Doing the residue in memory
 * rather than as a FilterExpression keeps one evaluator, one set of
 * semantics, and no expression-syntax surprises; at auth-table scale the
 * extra bytes read are not worth a second implementation of `contains`.
 *
 * Honest limits: an `OR` anywhere forces the model-partition read, because
 * a key lookup can only narrow an AND-set.
 */
export type Plan =
  | { kind: 'get'; pk: string; residue: CleanedWhere[] }
  | { kind: 'batchGet'; pks: string[]; residue: CleanedWhere[] }
  | { kind: 'query'; index: 'gsi1' | 'gsi2' | 'gsi3'; pk: string; residue: CleanedWhere[] }

const isEq = (w: CleanedWhere) => w.operator === 'eq' && w.value !== null && !Array.isArray(w.value)

export function plan(model: string, where: CleanedWhere[] | undefined, idField = 'id'): Plan {
  const clauses = where ?? []
  const modelPartition = (residue: CleanedWhere[]): Plan => ({ kind: 'query', index: 'gsi3', pk: model, residue })
  if (clauses.length === 0) return modelPartition([])

  // A chain with an OR in it cannot be narrowed by a key: `a = 1 OR b = 2`
  // needs rows that fail `a = 1`. (The first clause's connector is
  // meaningless - there is nothing before it - so it is ignored.)
  const hasOr = clauses.slice(1).some((w) => w.connector === 'OR')
  if (hasOr) return modelPartition(clauses)

  const idEq = clauses.find((w) => w.field === idField && isEq(w))
  if (idEq) {
    return { kind: 'get', pk: pkOf(model, idEq.value), residue: clauses.filter((w) => w !== idEq) }
  }
  const idIn = clauses.find((w) => w.field === idField && w.operator === 'in' && Array.isArray(w.value))
  if (idIn) {
    const pks = (idIn.value as Array<string | number>).map((v) => pkOf(model, v))
    return { kind: 'batchGet', pks, residue: clauses.filter((w) => w !== idIn) }
  }

  const defs = (INDEXES[model] ?? []).slice(0, 2)
  for (let i = 0; i < defs.length; i++) {
    const fields = defs[i]
    const used: CleanedWhere[] = []
    const parts: string[] = [model]
    let ok = true
    for (const f of fields) {
      const w = clauses.find((c) => c.field === f && isEq(c) && !used.includes(c))
      if (!w) {
        ok = false
        break
      }
      used.push(w)
      parts.push(f, keyValue(f, w.value))
    }
    if (ok) {
      return {
        kind: 'query',
        index: i === 0 ? 'gsi1' : 'gsi2',
        pk: parts.join('#'),
        // An insensitive email match is already satisfied by the lowercased
        // key; a sensitive one keeps its clause so casing is still checked.
        residue: clauses.filter((w) => !(used.includes(w) && (w.mode === 'insensitive' || !isEmailField(w.field)))),
      }
    }
  }
  return modelPartition(clauses)
}

// ── In-memory evaluation ───────────────────────────────────────────────────
// Ported from Better Auth's memory adapter so the two agree on every edge:
// null handling, insensitive mode, and the connector chain.

type Row = Record<string, unknown>

const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v)

function evalClause(row: Row, w: CleanedWhere): boolean {
  const { field, value, operator, mode } = w
  const actual = row[field]
  const insensitive =
    mode === 'insensitive'
    && (typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string')))
  const a = insensitive ? lower(actual) : actual
  const v = insensitive ? (Array.isArray(value) ? value.map(lower) : lower(value)) : value
  switch (operator) {
    case 'in':
      return Array.isArray(v) && (v as unknown[]).includes(a)
    case 'not_in':
      return Array.isArray(v) && !(v as unknown[]).includes(a)
    case 'contains':
      return typeof a === 'string' && typeof v === 'string' && a.includes(v)
    case 'starts_with':
      return typeof a === 'string' && typeof v === 'string' && a.startsWith(v)
    case 'ends_with':
      return typeof a === 'string' && typeof v === 'string' && a.endsWith(v)
    case 'ne':
      return v === null ? a != null : a !== v
    case 'gt':
      return v != null && a != null && (a as never) > (v as never)
    case 'gte':
      return v != null && a != null && (a as never) >= (v as never)
    case 'lt':
      return v != null && a != null && (a as never) < (v as never)
    case 'lte':
      return v != null && a != null && (a as never) <= (v as never)
    default:
      if (v === null) return a == null
      return a === v
  }
}

/** True when the row satisfies the chain, evaluated left to right like the memory adapter. */
export function matches(row: Row, where: CleanedWhere[]): boolean {
  if (where.length === 0) return true
  let result = evalClause(row, where[0])
  for (let i = 1; i < where.length; i++) {
    const r = evalClause(row, where[i])
    result = where[i].connector === 'OR' ? result || r : result && r
  }
  return result
}

export function sortRows(rows: Row[], sortBy?: { field: string; direction: 'asc' | 'desc' }): Row[] {
  if (!sortBy) return rows
  const { field, direction } = sortBy
  return [...rows].sort((x, y) => {
    const a = x[field]
    const b = y[field]
    let c = 0
    if (a == null && b == null) c = 0
    else if (a == null) c = -1
    else if (b == null) c = 1
    else if (typeof a === 'string' && typeof b === 'string') c = a.localeCompare(b)
    else if (typeof a === 'number' && typeof b === 'number') c = a - b
    else if (typeof a === 'boolean' && typeof b === 'boolean') c = a === b ? 0 : a ? 1 : -1
    else c = String(a).localeCompare(String(b))
    return direction === 'asc' ? c : -c
  })
}
