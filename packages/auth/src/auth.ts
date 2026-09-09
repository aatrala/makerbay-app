import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { betterAuth } from 'better-auth'
import { bearer, emailOTP, genericOAuth, jwt, oneTimeToken } from 'better-auth/plugins'
import { dynamoAdapter } from './adapter'
import { sendOtp } from './otp-mail'
import { upstreamProviders } from './providers'
import { authSecrets } from './secrets'

/**
 * The Better Auth instance (issue 157), built once per execution environment.
 *
 * What each piece is for:
 * - `emailOTP`: the only first-party sign-in. Six digits, ten minutes, five
 *   attempts, hashed at rest, sent through Resend with our own template.
 * - `bearer`: the SPA lives on app.makerbay.app and the API on
 *   api.makerbay.app, and the API's CORS allows every origin, which rules
 *   out credentials. So the session token travels as a bearer header, the
 *   way the Cognito token always has.
 * - `jwt`: mints the short-lived token the existing Lambda authorizer
 *   verifies against /auth/jwks, so nothing downstream changes.
 * - `genericOAuth`: the upstream seam; see providers.ts.
 * - `oneTimeToken`: after an upstream redirect the session lands in a cookie
 *   on api.makerbay.app; the bridge turns it into a token the SPA can hold.
 */
const SECONDS = { day: 24 * 60 * 60 }

async function build() {
  const { secret } = await authSecrets()
  const baseURL = required('AUTH_BASE_URL')
  const spa = required('AUTH_SPA_URL')
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  })

  return betterAuth({
    appName: 'MakerBay',
    baseURL,
    basePath: '/auth',
    secret,
    database: dynamoAdapter({ client, tableName: required('TABLE_AUTH') }),
    trustedOrigins: [spa, ...(process.env.AUTH_EXTRA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)],
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: 7 * SECONDS.day,
      updateAge: 1 * SECONDS.day,
    },
    account: {
      accountLinking: {
        enabled: true,
        // Only a provider whose email claim we trust may attach itself to an
        // existing user by email. Anything else would let a stranger's
        // account on a lax IdP take over a MakerBay workspace.
        trustedProviders: ['cognito'],
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
    },
    advanced: {
      // Behind API Gateway the client IP arrives in x-forwarded-for.
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
    plugins: [
      emailOTP({
        sendVerificationOTP: sendOtp,
        otpLength: 6,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        storeOTP: 'hashed',
      }),
      bearer(),
      jwt({
        jwt: {
          issuer: baseURL,
          audience: baseURL,
          expirationTime: '15m',
          // The default embeds the whole user row. The authorizer needs the
          // subject and the email, nothing else.
          definePayload: ({ user }) => ({ email: user.email, emailVerified: user.emailVerified }),
        },
      }),
      oneTimeToken({ expiresIn: 3, storeToken: 'hashed' }),
      genericOAuth({ config: upstreamProviders() }),
    ],
  })
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export type Auth = Awaited<ReturnType<typeof build>>

let instance: Promise<Auth> | undefined

export function getAuth(): Promise<Auth> {
  instance ??= build()
  return instance
}
