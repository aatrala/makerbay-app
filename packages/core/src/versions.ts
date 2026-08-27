import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from './db'
import { ulid } from './ids'

/**
 * Undo for the surfaces an agent can write.
 *
 * Presence has had per-save snapshots since issue 45, and that is why a bad
 * page edit has always been reversible. Booking config, service prices and
 * assistant settings had neither a trail nor a way back: a wrong price or an
 * opened Saturday left no record and could not be rolled back.
 *
 * That was survivable while the only writer was the owner, pressing a button
 * they meant to press. It is not survivable once the setup agent writes on
 * their behalf (docs/spec-concierge.md), so this exists before that does.
 *
 * Undo is free on every tier. See the note in presence/api/src/page.ts.
 */

const TABLE = () => process.env.TABLE_CONFIGVERSIONS!

/** The surfaces that carry history. Adding one is a deliberate act. */
export type VersionedSurface =
  | 'booking.config'
  | 'booking.services'
  | 'assistant.config'

/** A screenful of history, matching presence's KEEP_VERSIONS. */
const KEEP = 20

export interface ConfigVersion<T = unknown> {
  sk: string
  at: string
  label: string
  actor?: string
  snapshot: T
}

/**
 * Record what a surface looked like BEFORE a write. Call it with the value
 * you are about to replace, not the one you are writing, so restoring a
 * version returns the state the owner last saw.
 */
export async function snapshotConfig(
  tenantId: string,
  surface: VersionedSurface,
  snapshot: unknown,
  label: string,
  actor?: string,
): Promise<void> {
  const pk = `${tenantId}#${surface}`
  const sk = `${new Date().toISOString()}#${ulid()}`
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE(),
      Item: { pk, sk, label: label.slice(0, 120), actor, snapshot },
    }))
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': pk },
      ScanIndexForward: false,
      ProjectionExpression: 'pk, sk',
    }))
    for (const item of (r.Items ?? []).slice(KEEP)) {
      await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { pk, sk: item.sk } }))
    }
  } catch (err) {
    // A snapshot must never block the save it is recording. Losing one entry
    // of history is bad; refusing to let an owner change their hours is worse.
    console.warn('snapshot failed', { surface, err: String(err) })
  }
}

export async function listConfigVersions<T = unknown>(
  tenantId: string,
  surface: VersionedSurface,
): Promise<Array<ConfigVersion<T>>> {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE(),
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': `${tenantId}#${surface}` },
    ScanIndexForward: false,
    Limit: KEEP,
  }))
  return (r.Items ?? []).map((v) => ({
    sk: String(v.sk),
    at: String(v.sk).split('#')[0],
    label: String(v.label ?? 'saved'),
    actor: v.actor as string | undefined,
    snapshot: v.snapshot as T,
  }))
}

export async function readConfigVersion<T = unknown>(
  tenantId: string,
  surface: VersionedSurface,
  sk: string,
): Promise<T | undefined> {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE(),
    KeyConditionExpression: 'pk = :p AND sk = :s',
    ExpressionAttributeValues: { ':p': `${tenantId}#${surface}`, ':s': sk },
    Limit: 1,
  }))
  return r.Items?.[0]?.snapshot as T | undefined
}
