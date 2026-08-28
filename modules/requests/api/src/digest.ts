import { ScanCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, getTenant, isPaidWorkspace, sendEmail } from '@makerbay/core'
import { getRequestsConfig } from './db'

/**
 * The free tier's lead notification: one morning email summarising the last
 * 24 hours of requests (issue 50). Paid workspaces are emailed the moment a
 * lead lands, so they are skipped here. Runs daily at 21:00 UTC - 7-8am on
 * the Australian east coast, where the first customers live.
 */

const APP = 'https://app.makerbay.app'

export const handler = async (): Promise<void> => {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString()
  const byTenant = new Map<string, Array<Record<string, unknown>>>()

  let key: Record<string, unknown> | undefined
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: process.env.TABLE_REQUESTS!,
        FilterExpression: 'createdAt >= :s',
        ExpressionAttributeValues: { ':s': since },
        ExclusiveStartKey: key,
      }),
    )
    for (const item of r.Items ?? []) {
      const t = String(item.tenantId)
      if (!byTenant.has(t)) byTenant.set(t, [])
      byTenant.get(t)!.push(item)
    }
    key = r.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (key)

  for (const [tenantId, rows] of byTenant) {
    try {
      if (await isPaidWorkspace(tenantId)) continue // instant alerts already went

      const config = await getRequestsConfig(tenantId)
      const tenant = await getTenant(tenantId)
      const to = config.notifyEmail || (await ownerEmail(tenantId))
      if (!to) continue

      const lines = rows
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .map((r) => {
          const who = r.name || r.email || r.phone || 'someone'
          return `- ${who}: ${String(r.subject ?? r.message ?? '').slice(0, 90)}`
        })
      await sendEmail({
        to,
        audience: 'owner' as const,
        ref: { tenantId, moduleId: 'requests', refType: 'request', refId: `digest-${rows[0]?.requestId ?? 'none'}` },
        optional: true,
        subject: `${rows.length} new request${rows.length === 1 ? '' : 's'} for ${tenant?.name ?? 'your business'} yesterday`,
        text: [
          `While you were working, ${rows.length === 1 ? 'someone' : `${rows.length} people`} left you a message:`,
          '',
          ...lines,
          '',
          `Answer them: ${APP}/requests`,
          '',
          'On the Trade plan these arrive the moment each lead lands, not the morning after.',
        ].join('\n'),
      })
      console.log('digest sent', { tenantId, count: rows.length })
    } catch (err) {
      console.warn('digest failed for tenant', { tenantId, err: String(err) })
    }
  }
}

async function ownerEmail(tenantId: string): Promise<string> {
  // The requests handler resolves this through the users table; here a scan
  // is fine - the digest runs once a day.
  const r = await ddb.send(
    new ScanCommand({
      TableName: process.env.TABLE_USERS!,
      FilterExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
    }),
  )
  const owner = (r.Items ?? []).find((u) => u.role === 'owner')
  return owner?.email ? String(owner.email) : ''
}
