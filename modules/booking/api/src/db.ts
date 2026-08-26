import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb } from '@makerbay/core'
import type { BookingHours } from './slots'

const Tables = {
  services: () => process.env.TABLE_BOOKINGSERVICES!,
  bookings: () => process.env.TABLE_BOOKINGS!,
  config: () => process.env.TABLE_BOOKINGCONFIG!,
}

export interface ServiceRow {
  tenantId: string
  serviceId: string
  name: string
  description?: string
  durationMinutes: number
  bufferMinutes: number
  priceCents?: number
  /** Fixed deposit to secure a booking (spec-booking-deposits.md). 0/absent = off. */
  depositCents?: number
  active: boolean
  createdAt: string
}

/** pending_payment is transient: a held slot awaiting its deposit. */
export type BookingStatus = 'confirmed' | 'cancelled' | 'completed' | 'noshow' | 'pending_payment'

export interface BookingRow {
  tenantId: string
  bookingId: string
  /**
   * A 'block' is owner-reserved time (school run, supplier visit) stored as a
   * booking row so every free-slot and conflict check treats it as taken
   * without knowing it exists. Absent means a real appointment.
   */
  kind?: 'block'
  contactId: string
  serviceId: string
  serviceName: string
  /** Always stored as a UTC instant. Display converts; storage never does. */
  startsAt: string
  endsAt: string
  status: BookingStatus
  name?: string
  email?: string
  phone?: string
  note?: string
  /** Lets the customer cancel from the confirmation email without an account. */
  cancelToken: string
  source: 'hosted' | 'widget' | 'dashboard' | 'api'
  notifyError?: string
  /** Deposit stamped from the service at create time; paid via Stripe. */
  depositCents?: number
  depositPaidAt?: string
  paymentId?: string
  /** Only on pending_payment rows: the slot is held until this instant. */
  holdExpiresAt?: string
  createdAt: string
  updatedAt: string
  cancelledAt?: string
}

export interface BookingConfigRow extends BookingHours {
  tenantId: string
  notifyEmail: string
  /** Shown on the public booking page above the slot picker. */
  intro: string
}

export const DEFAULT_BOOKING_CONFIG: Omit<BookingConfigRow, 'tenantId'> = {
  timezone: 'Australia/Sydney',
  hours: {
    mon: [{ from: '09:00', to: '17:00' }],
    tue: [{ from: '09:00', to: '17:00' }],
    wed: [{ from: '09:00', to: '17:00' }],
    thu: [{ from: '09:00', to: '17:00' }],
    fri: [{ from: '09:00', to: '17:00' }],
  },
  leadTimeHours: 12,
  horizonDays: 60,
  closures: [],
  notifyEmail: '',
  intro: 'Pick a time that suits you.',
}

export async function getBookingConfig(tenantId: string): Promise<BookingConfigRow> {
  const r = await ddb.send(new GetCommand({ TableName: Tables.config(), Key: { tenantId } }))
  return { tenantId, ...DEFAULT_BOOKING_CONFIG, ...(r.Item ?? {}) } as BookingConfigRow
}

export async function putBookingConfig(row: BookingConfigRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.config(), Item: row }))
}

export async function listServices(tenantId: string): Promise<ServiceRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.services(),
      KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': tenantId },
    }),
  )
  return ((r.Items ?? []) as ServiceRow[]).sort((a, b) => a.name.localeCompare(b.name))
}

export async function getService(tenantId: string, serviceId: string): Promise<ServiceRow | undefined> {
  const r = await ddb.send(
    new GetCommand({ TableName: Tables.services(), Key: { tenantId, serviceId } }),
  )
  return r.Item as ServiceRow | undefined
}

export async function putService(row: ServiceRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.services(), Item: row }))
}

export async function deleteService(tenantId: string, serviceId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: Tables.services(), Key: { tenantId, serviceId } }))
}

export async function putBooking(row: BookingRow): Promise<void> {
  await ddb.send(new PutCommand({ TableName: Tables.bookings(), Item: row }))
}

export async function getBooking(tenantId: string, bookingId: string): Promise<BookingRow | undefined> {
  const r = await ddb.send(
    new GetCommand({ TableName: Tables.bookings(), Key: { tenantId, bookingId } }),
  )
  return r.Item as BookingRow | undefined
}

/**
 * Bookings overlapping a window. The byStart index is what both the diary and
 * the conflict check need, so neither has to scan the table.
 */
export async function bookingsBetween(
  tenantId: string,
  fromISO: string,
  toISO: string,
): Promise<BookingRow[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: Tables.bookings(),
      IndexName: 'byStart',
      KeyConditionExpression: 'tenantId = :t AND startsAt BETWEEN :a AND :b',
      ExpressionAttributeValues: { ':t': tenantId, ':a': fromISO, ':b': toISO },
    }),
  )
  return (r.Items ?? []) as BookingRow[]
}

/**
 * Only bookings that still hold their time. Cancelled ones free their slot;
 * a pending deposit holds it until the hold lapses (35 min - always past the
 * 30-min Stripe checkout expiry, so a payment can never land on a freed slot).
 */
export const blocking = (rows: BookingRow[], now = Date.now()): BookingRow[] =>
  rows.filter(
    (b) =>
      b.status === 'confirmed' ||
      b.status === 'completed' ||
      (b.status === 'pending_payment' && new Date(b.holdExpiresAt ?? 0).getTime() > now),
  )

export async function findByCancelToken(
  tenantId: string,
  token: string,
): Promise<BookingRow | undefined> {
  // Tokens are short-lived in practice and the window is small, so a scoped
  // query beats maintaining another index for a rare lookup.
  const soon = new Date(Date.now() - 86_400_000).toISOString()
  const far = new Date(Date.now() + 400 * 86_400_000).toISOString()
  const rows = await bookingsBetween(tenantId, soon, far)
  return rows.find((b) => b.cancelToken === token)
}

export async function countBookingsThisMonth(tenantId: string): Promise<number> {
  const monthStart = new Date().toISOString().slice(0, 7)
  const from = new Date(Date.now() - 86_400_000).toISOString()
  const to = new Date(Date.now() + 400 * 86_400_000).toISOString()
  const rows = await bookingsBetween(tenantId, from, to)
  // Blocks are the owner's own time, not customers - they never count
  // against the monthly booking cap. Unpaid deposit holds don't either;
  // they count the moment they confirm.
  return rows.filter(
    (b) => !b.kind && b.status !== 'pending_payment' && b.createdAt.startsWith(monthStart),
  ).length
}

/**
 * Flip a held slot to confirmed when its deposit lands. Conditional on the
 * row still being pending_payment: a payment arriving for a lapsed hold (or
 * arriving twice) must fail loudly rather than resurrect the booking.
 */
export async function confirmDepositPaid(
  tenantId: string,
  bookingId: string,
  paymentId: string,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: Tables.bookings(),
      Key: { tenantId, bookingId },
      UpdateExpression:
        'SET #st = :confirmed, depositPaidAt = :now, paymentId = :p, updatedAt = :now REMOVE holdExpiresAt',
      ConditionExpression: '#st = :pending',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':confirmed': 'confirmed',
        ':pending': 'pending_payment',
        ':p': paymentId,
        ':now': new Date().toISOString(),
      },
    }),
  )
}

export async function deleteBooking(tenantId: string, bookingId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: Tables.bookings(), Key: { tenantId, bookingId } }))
}
