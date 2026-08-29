import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider'

/**
 * Signs up, every fifteen minutes, so a human does not have to (issue 145).
 *
 * Between 27 and 29 August nobody could create a MakerBay account. Moving
 * Cognito's codes onto SES was correct in every respect except one: in the
 * sandbox SES authorises the RECIPIENT, and a person signing up has by
 * definition never been verified. Every signup was rejected before a code was
 * sent.
 *
 * It was found by a code review three days later. Not by an alarm, because
 * there was no alarm: every existing alarm watches cost or deliverability, and
 * not one watches whether the front door opens. A green unit suite proved
 * nothing, exactly as it proved nothing for issue 107's reserved keyword.
 *
 * So this does the only thing that would have caught it: it actually signs up.
 *
 * **Why a real address rather than a verified one.** Signing up as
 * canary@makerbay.app would have passed happily throughout the outage, because
 * makerbay.app is a verified SES identity and the bug only affected everyone
 * else. The canary must look like a stranger or it tests nothing. It uses
 * example.com, which IANA reserves and which never accepts mail, so no message
 * can reach a real person however the sender is configured.
 *
 * The user is deleted immediately, whether or not the signup succeeded.
 */

const cognito = new CognitoIdentityProviderClient({})

const NAMESPACE = 'MakerBay/Canary'

/** A password that satisfies any sane policy and is never reused. */
const throwawayPassword = (): string =>
  `Cy-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2).toUpperCase()}-9!`

/**
 * Publishes the result as a CloudWatch metric by logging it.
 *
 * Embedded metric format: CloudWatch reads this shape out of the log stream
 * and creates the metric itself. That means no SDK client, no PutMetricData
 * permission, and no second network call that could fail separately from the
 * thing being measured - the log line IS the metric.
 */
function publish(ok: boolean, detail: string): void {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: NAMESPACE,
        Dimensions: [[]],
        Metrics: [{ Name: 'SignupWorks', Unit: 'None' }],
      }],
    },
    SignupWorks: ok ? 1 : 0,
    canary: 'signup',
    detail,
  }))
}

export const handler = async (): Promise<void> => {
  const poolId = process.env.USER_POOL_ID
  const clientId = process.env.USER_POOL_CLIENT_ID
  if (!poolId || !clientId) {
    publish(false, 'canary is misconfigured: no user pool')
    return
  }

  // Unique per run, so a leftover user from a failed cleanup cannot make the
  // next run look broken.
  const email = `signup-canary-${Date.now()}@example.com`
  let created = false

  try {
    const r = await cognito.send(new SignUpCommand({
      ClientId: clientId,
      Username: email,
      Password: throwawayPassword(),
      UserAttributes: [{ Name: 'email', Value: email }],
    }))
    // Cognito only reports delivery details when it actually handed the
    // message to a sender. Their absence is the shape the outage took.
    created = true
    const delivered = Boolean(r.CodeDeliveryDetails?.Destination)
    publish(delivered, delivered
      ? 'signup accepted and a code was dispatched'
      : 'signup accepted but NO code was dispatched - check the user pool sender')
  } catch (err) {
    const name = (err as { name?: string }).name ?? 'Error'
    const message = (err as { message?: string }).message ?? ''
    // A duplicate is not an outage; it means a previous cleanup failed.
    if (name === 'UsernameExistsException') {
      publish(true, 'a previous canary user was left behind, signup itself is fine')
    } else {
      publish(false, `${name}: ${message}`.slice(0, 300))
    }
  } finally {
    if (created) {
      try {
        await cognito.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: email }))
      } catch (err) {
        // Left behind rather than lost: the next run uses a new address, and
        // the handler above treats a duplicate as healthy.
        console.warn('canary user not deleted', { email, err: String(err) })
      }
    }
  }
}
