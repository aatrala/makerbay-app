import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

/**
 * Asks for a sign-in code, every hour, so a human does not have to
 * (issue 145, rewritten for issue 158).
 *
 * Between 27 and 29 August nobody could create a MakerBay account, and it
 * was found by a code review three days later because no alarm watched the
 * front door. The front door is now Better Auth's code sign-in through
 * Resend, so that is what this exercises: request a code for one of
 * Resend's delivery test addresses, then confirm through Resend's own log
 * that a message to that address was created after the request and was
 * delivered.
 *
 * **Why not assert on the API's answer.** Better Auth answers `success`
 * to a code request even when the email failed to send - it swallows the
 * send error in its background-task wrapper. A canary that trusted that
 * answer would be green during exactly the outage it exists to catch. The
 * delivery record is the only honest signal.
 *
 * **Why hourly.** Each run is one Resend message. Twenty-four a day is
 * noise on a paid tier and a quarter of the free tier's daily cap; four a
 * day, the old cadence, would leave an outage unnoticed for six hours.
 */
const NAMESPACE = 'MakerBay/Canary'
const sm = new SecretsManagerClient({})

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

async function resendKey(): Promise<string> {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.RESEND_SECRET_ARN! }))
  const parsed = JSON.parse(r.SecretString ?? '{}') as Record<string, string>
  const key = parsed.apiKey ?? parsed.api_key ?? ''
  if (!key.startsWith('re_')) throw new Error('resend key unusable')
  return key
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const handler = async (): Promise<void> => {
  const base = process.env.AUTH_BASE_URL
  if (!base || !process.env.RESEND_SECRET_ARN) {
    publish(false, 'canary is misconfigured: no auth base URL or resend secret')
    return
  }
  // Unique per run, and a Resend test address: delivered on their side,
  // never handed to a real mailbox, and plus-addressed so each run can be
  // told apart in the log.
  const email = `delivered+canary-${Date.now()}@resend.dev`
  const startedAt = Date.now()

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

  // Delivery to resend.dev takes seconds; give it a minute, checking as it goes.
  let key: string
  try {
    key = await resendKey()
  } catch (err) {
    publish(false, `cannot read the resend key: ${String((err as Error)?.message ?? err)}`)
    return
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(10_000)
    try {
      const res = await fetch('https://api.resend.com/emails?limit=20', {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      })
      const json = (await res.json()) as { data?: Array<{ to?: string[]; created_at?: string; last_event?: string }> }
      // The address is unique to this run, so any message to it is ours; no
      // time comparison, because Resend's `created_at` ("2026-09-09
      // 14:10:52.520000+00") is not something Date.parse understands.
      const mine = (json.data ?? []).find((e) => (e.to ?? []).includes(email))
      if (mine) {
        if (mine.last_event === 'delivered' || mine.last_event === 'opened') {
          publish(true, `code requested and delivered (${Date.now() - startedAt} ms)`)
          return
        }
        if (mine.last_event === 'bounced' || mine.last_event === 'failed' || mine.last_event === 'complained') {
          publish(false, `code email ended as ${mine.last_event}`)
          return
        }
      }
    } catch (err) {
      console.warn('resend log check failed', { attempt, err: String(err) })
    }
  }
  publish(false, 'code requested but no delivered message appeared in the Resend log within a minute')
}
