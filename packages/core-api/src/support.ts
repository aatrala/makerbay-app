import type { APIGatewayProxyResultV2 } from 'aws-lambda'
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, getEntitlements, getTenant, json, listGrants, sendEmail, ulid } from '@makerbay/core'

/**
 * Support tickets (issue 49 V1). Customers write from the dashboard, staff
 * answer in the console, and email carries notifications both ways - the
 * thread itself lives here, so nothing depends on an inbox.
 */

const Tickets = () => process.env.TABLE_TICKETS!

export type TicketCategory = 'problem' | 'question' | 'idea'
export type TicketStatus = 'open' | 'answered' | 'closed'

export interface TicketMessage {
  from: 'customer' | 'staff'
  text: string
  at: string
  by?: string
}

export interface TicketRow {
  tenantId: string
  ticketId: string
  subject: string
  category: TicketCategory
  status: TicketStatus
  /** Paid workspaces sort first in the staff queue. */
  priority: 'standard' | 'priority'
  messages: TicketMessage[]
  openedBy: string
  openedByEmail?: string
  tenantName?: string
  createdAt: string
  updatedAt: string
}

const CATEGORIES: TicketCategory[] = ['problem', 'question', 'idea']
const MAX_OPEN_FREE = 3
const MAX_MESSAGES = 50

async function isPaid(tenantId: string): Promise<boolean> {
  const [ent, grants] = await Promise.all([getEntitlements(tenantId), listGrants(tenantId)])
  const now = new Date().toISOString()
  return (
    ent.modules.assistant?.plan === 'pro' ||
    grants.some((g) => g.status === 'active' && (!g.expiresAt || g.expiresAt > now))
  )
}

export async function listTickets(tenantId: string): Promise<APIGatewayProxyResultV2> {
  const r = await ddb.send(new QueryCommand({
    TableName: Tickets(),
    KeyConditionExpression: 'tenantId = :t',
    ExpressionAttributeValues: { ':t': tenantId },
    ScanIndexForward: false,
    Limit: 50,
  }))
  const rows = ((r.Items ?? []) as TicketRow[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return json(200, { tickets: rows })
}

export async function createTicket(
  tenantId: string,
  actor: { userId?: string; email?: string },
  b: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const category = CATEGORIES.includes(b.category as TicketCategory)
    ? (b.category as TicketCategory)
    : 'question'
  const subject = String(b.subject ?? '').trim().slice(0, 140)
  const message = String(b.message ?? '').trim().slice(0, 4000)
  if (subject.length < 3) return json(400, { error: 'subject_required' })
  if (message.length < 10) {
    return json(400, { error: 'message_required', message: 'Say a little more so we can actually help.' })
  }

  const paid = await isPaid(tenantId)
  if (!paid) {
    const r = await ddb.send(new QueryCommand({
      TableName: Tickets(),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
    }))
    const open = ((r.Items ?? []) as TicketRow[]).filter((t) => t.status !== 'closed').length
    if (open >= MAX_OPEN_FREE) {
      return json(429, {
        error: 'too_many_open',
        message: `You already have ${open} open tickets - we will answer those first.`,
      })
    }
  }

  const tenant = await getTenant(tenantId)
  const now = new Date().toISOString()
  const row: TicketRow = {
    tenantId,
    ticketId: ulid(),
    subject,
    category,
    status: 'open',
    priority: paid ? 'priority' : 'standard',
    messages: [{ from: 'customer', text: message, at: now, by: actor.email }],
    openedBy: actor.userId ?? '',
    openedByEmail: actor.email,
    tenantName: tenant?.name,
    createdAt: now,
    updatedAt: now,
  }
  await ddb.send(new PutCommand({ TableName: Tickets(), Item: row }))

  await sendEmail({
    to: process.env.SUPPORT_EMAIL ?? '',
    replyTo: actor.email,
    subject: `[${row.priority === 'priority' ? 'PRIORITY' : 'support'}] ${category}: ${subject}`,
    text: [
      `${tenant?.name ?? tenantId} (${actor.email ?? 'no email'}) opened a ticket.`,
      '',
      message,
      '',
      `Answer it in the staff console: https://admin.makerbay.app/tickets`,
    ].join('\n'),
  })
  return json(201, { ticket: row })
}

export async function replyTicket(
  tenantId: string,
  ticketId: string,
  actor: { userId?: string; email?: string },
  b: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const text = String(b.message ?? '').trim().slice(0, 4000)
  if (text.length < 2) return json(400, { error: 'message_required' })

  const r = await ddb.send(new GetCommand({ TableName: Tickets(), Key: { tenantId, ticketId } }))
  const ticket = r.Item as TicketRow | undefined
  if (!ticket) return json(404, { error: 'not_found' })
  if (ticket.messages.length >= MAX_MESSAGES) return json(409, { error: 'thread_full' })

  const now = new Date().toISOString()
  const updated: TicketRow = {
    ...ticket,
    // A customer reply re-opens an answered (or even closed) thread.
    status: 'open',
    messages: [...ticket.messages, { from: 'customer', text, at: now, by: actor.email }],
    updatedAt: now,
  }
  await ddb.send(new PutCommand({ TableName: Tickets(), Item: updated }))
  await sendEmail({
    to: process.env.SUPPORT_EMAIL ?? '',
    replyTo: actor.email,
    subject: `Re: ${ticket.subject}`,
    text: [
      `${ticket.tenantName ?? tenantId} replied:`,
      '',
      text,
      '',
      `Thread: https://admin.makerbay.app/tickets`,
    ].join('\n'),
  })
  return json(200, { ticket: updated })
}
