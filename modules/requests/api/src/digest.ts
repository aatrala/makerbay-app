import { ScanCommand } from '@aws-sdk/lib-dynamodb'
import { requestsDigest } from '@makerbay/email'
import {
  ddb, getTenant, isPaidWorkspace, sendEmail, unsubTokenFor, unsubUrl,
} from '@makerbay/core'
import { getRequestsConfig } from './db'

/**
 * The free tier's lead notification: one morning email summarising the last
 * 24 hours of requests (issue 50). Paid workspaces are emailed the moment a
 * lead lands, so they are skipped here. Runs daily at 21:00 UTC - 7-8am on
 * the Australian east coast, where the first customers live.
 */


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

      // The real per-address token, minted before the template renders: the
      // digest's unsubscribe link goes into both the HTML footer and the text
      // part, and sendEmail only ever sees the finished strings.
      const unsubToken = await unsubTokenFor(tenantId, to)
      const mail = requestsDigest({
        businessName: tenant?.name ?? 'your business',
        items: rows
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
          .map((r) => ({
            who: String(r.name || r.email || r.phone || 'someone'),
            summary: String(r.subject ?? r.message ?? '').slice(0, 90),
          })),
        unsubscribeUrl: unsubToken ? unsubUrl(unsubToken) : '',
      })
      await sendEmail({
        to,
        audience: 'owner' as const,
        ref: { tenantId, moduleId: 'requests', refType: 'request', refId: `digest-${rows[0]?.requestId ?? 'none'}` },
        optional: true,
        // Minted once above for the footer; passing it spares sendEmail a
        // second lookup and keeps header and footer from ever disagreeing.
        ...(unsubToken ? { unsubToken } : {}),
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
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
