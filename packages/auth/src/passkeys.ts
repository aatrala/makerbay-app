import { getAuthenticatorName, passkey } from '@better-auth/passkey'
import { sendEmail } from '@makerbay/core'
import { passkeyChanged } from '@makerbay/email'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'

/**
 * Passkeys, in the customer's words "sign in with your fingerprint next
 * time" (issue 158 part B1). The plugin does the WebAuthn ceremony; this
 * file holds the three decisions the spec makes and the plugin does not:
 *
 * 1. **User verification is required, and enforced on the server.** The
 *    plugin ASKS the authenticator for verification but verifies with
 *    `requireUserVerification: false`, so a key that skipped the fingerprint
 *    would pass. As a passwordless first factor that is possession-only,
 *    weaker than the inbox-protected code it replaces. Both
 *    `afterVerification` callbacks read the verified flag and refuse.
 * 2. **Every add and every remove emails the account.** A passkey outlives
 *    "sign out everywhere", so the email is the tripwire and the Account
 *    page is where it is undone. Adds go through the registration callback;
 *    removes have no callback, so a before/after hook pair around
 *    `/passkey/delete-passkey` remembers the row's name and mails once the
 *    delete has succeeded.
 * 3. **Devices get a plain name.** The plugin stores whatever the client
 *    sends; a browser cannot always name itself well, so the label falls
 *    back to the authenticator's make (Windows Hello, iCloud Keychain) and
 *    then to what the user agent says the device is.
 *
 * The rpID is the apex domain so one credential covers app. and any future
 * host; the origin is exactly the dashboard, so nothing else can complete a
 * ceremony.
 */
const required = (name: string): string => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export function passkeyPlugin() {
  const origin = required('AUTH_SPA_URL')
  const rpID = process.env.AUTH_RP_ID ?? new URL(origin).hostname
  return passkey({
    rpID,
    rpName: 'MakerBay',
    origin: [origin],
    authenticatorSelection: {
      // Discoverable when the authenticator allows it, so the browser can
      // offer the passkey before an email is typed.
      residentKey: 'preferred',
      userVerification: 'required',
    },
    registration: {
      afterVerification: async ({ ctx, verification, user }) => {
        const info = verification.registrationInfo
        if (!info?.userVerified) {
          throw new APIError('BAD_REQUEST', {
            message: 'That device did not check who you are. Use a fingerprint, face or PIN.',
            code: 'USER_VERIFICATION_REQUIRED',
          })
        }
        const name = deviceLabel(info.aaguid, ctx.headers?.get('user-agent'))
        const typed = typeof ctx.body?.name === 'string' ? ctx.body.name.trim() : ''
        await tell(ctx, user.id, 'added', typed || name)
        return { name }
      },
    },
    authentication: {
      afterVerification: async ({ verification }) => {
        if (!verification.authenticationInfo.userVerified) {
          throw new APIError('UNAUTHORIZED', {
            message: 'That device did not check who you are. Use a fingerprint, face or PIN.',
            code: 'USER_VERIFICATION_REQUIRED',
          })
        }
      },
    },
  })
}

/** Rows about to be deleted, keyed by the request so before and after agree. */
const pendingRemovals = new WeakMap<object, { name?: string; userId: string }>()
const requestKey = (ctx: { request?: Request; headers?: Headers }): object | undefined => ctx.request ?? ctx.headers

export const passkeyHooks = {
  before: createAuthMiddleware(async (ctx) => {
    if (ctx.path !== '/passkey/delete-passkey') return
    const id = ctx.body?.id
    const key = requestKey(ctx)
    if (typeof id !== 'string' || !key) return
    const row = await ctx.context.adapter.findOne<{ name?: string; userId: string }>({
      model: 'passkey',
      where: [{ field: 'id', value: id }],
    })
    if (row) pendingRemovals.set(key, row)
  }),
  after: createAuthMiddleware(async (ctx) => {
    if (ctx.path !== '/passkey/delete-passkey') return
    const key = requestKey(ctx)
    const row = key ? pendingRemovals.get(key) : undefined
    if (key) pendingRemovals.delete(key)
    if (!row) return
    const returned = ctx.context.returned
    if (returned instanceof APIError || returned instanceof Error) return
    const session = await getSessionFromCtx(ctx)
    // Ownership was checked by the endpoint; this guards the email, not the delete.
    if (!session || session.user.id !== row.userId) return
    await tell(ctx, row.userId, 'removed', row.name || 'A device')
  }),
}

async function tell(
  ctx: { context: { internalAdapter: { findUserById: (id: string) => Promise<{ email: string } | null> } } },
  userId: string,
  action: 'added' | 'removed',
  deviceName: string,
): Promise<void> {
  const user = await ctx.context.internalAdapter.findUserById(userId)
  if (!user?.email) return
  const m = passkeyChanged({ action, deviceName, when: whenNow() })
  const r = await sendEmail({ to: user.email, audience: 'owner', subject: m.subject, text: m.text, html: m.html })
  if (!r.sent) {
    // Not fatal to the ceremony, but the tripwire failed to fire; the same
    // log line the code alarm watches, so it pages the same way.
    console.error('sign-in code not sent', { kind: `passkey_${action}`, error: r.error })
  }
}

/** "on Tuesday 9 September at 2:15pm (AEST)". Australia first; see founder-focus. */
function whenNow(now = new Date()): string {
  const tz = process.env.NOTIFY_TZ ?? 'Australia/Sydney'
  const day = new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(now)
  const time = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' })
    .format(now)
    .replace(/\s?([ap])\.?m\.?/i, '$1m')
    .replace(' ', ' ')
  return `on ${day} at ${time}`
}

/**
 * A name a person would recognise in a list. Apple zeroes the AAGUID under
 * the "none" attestation the plugin asks for, so the make is often unknown
 * and the user agent has to do.
 */
export function deviceLabel(aaguid: string | undefined, userAgent: string | null | undefined): string {
  const make = getAuthenticatorName(aaguid)
  if (make) return make
  const ua = userAgent ?? ''
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad|Macintosh.*Mobile/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android phone'
  if (/Windows/.test(ua)) return 'Windows PC'
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac'
  if (/CrOS/.test(ua)) return 'Chromebook'
  if (/Linux/.test(ua)) return 'Linux PC'
  return 'This device'
}
