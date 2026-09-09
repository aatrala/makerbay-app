import { mailForRef, sendEmail } from '@makerbay/core'

/**
 * Asks the front door for a sign-in code, every hour, so a human does not
 * have to (issue 145, rewritten for issue 158).
 *
 * Between 27 and 29 August nobody could create a MakerBay account, and it
 * was found by a code review three days later because no alarm watched the
 * front door. The front door is now Better Auth's code sign-in through
 * Resend. Two things have to be true for it to work, and this checks both:
 *
 * 1. **The auth endpoint accepts a code request.** A real POST to the live
 *    endpoint, as a customer's browser would make it.
 * 2. **Mail actually leaves and arrives.** Better Auth answers `success`
 *    even when the email failed to send (it swallows the error), so the
 *    answer to step 1 proves nothing about delivery. The canary therefore
 *    sends its own probe through the same `sendEmail` the code goes
 *    through, to one of Resend's delivery test addresses, tagged so the
 *    provider's delivery event comes back through our webhook into the
 *    mail log - and waits for that row to read `delivered`. Same provider,
 *    same key, same pipeline, observed end to end.
 *
 * Reading Resend's own log was the first design; it needs a full-access
 * key, and the key in the secret is sending-only on purpose.
 */
const NAMESPACE = 'MakerBay/Canary'
const TENANT = 'CANARY'

function publish(ok: boolean, detail: string): void {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{ Namespace: NAMESPACE, Dimensions: [[]], Metrics: [{ Name: 'SignupWorks', Unit: 'None' }] }],
    },
    SignupWorks: ok ? 1 : 0,
    canary: 'signup',
    detail,
  }))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const handler = async (): Promise<void> => {
  const base = process.env.AUTH_BASE_URL
  if (!base) {
    publish(false, 'canary is misconfigured: no auth base URL')
    return
  }
  const stamp = Date.now()
  // Unique per run, and a Resend test address: delivered on their side,
  // never handed to a real mailbox.
  const email = `delivered+canary-${stamp}@resend.dev`

  // 1. The front door.
  try {
    const r = await fetch(`${base}/auth/email-otp/send-verification-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: process.env.AUTH_SPA_URL ?? base },
      body: JSON.stringify({ email, type: 'sign-in' }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      publish(false, `code request answered ${r.status}`)
      return
    }
  } catch (err) {
    publish(false, `code request failed: ${String((err as Error)?.message ?? err)}`.slice(0, 300))
    return
  }

  // 2. The pipeline, observed through our own webhook.
  const refId = `probe-${stamp}`
  const sent = await sendEmail({
    to: email,
    audience: 'staff',
    subject: 'MakerBay canary: the mail pipeline works',
    text: 'Automated check that sign-in codes can leave the building. No action needed.',
    ref: { tenantId: TENANT, moduleId: 'platform', refType: 'auth', refId },
  })
  if (!sent.sent) {
    publish(false, `probe email not accepted by the provider: ${sent.error ?? 'unknown'}`)
    return
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(10_000)
    const rows = await mailForRef(TENANT, 'auth', refId)
    const states = rows.map((r) => r.state)
    if (states.includes('delivered')) {
      publish(true, `code request accepted and a probe email was delivered (${Date.now() - stamp} ms)`)
      return
    }
    const bad = states.find((s) => s === 'bounced' || s === 'complained' || s === 'rejected')
    if (bad) {
      publish(false, `probe email ended as ${bad}`)
      return
    }
  }
  publish(false, 'code request accepted but no delivery event reached the mail log within a minute')
}
