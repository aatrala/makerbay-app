import * as cdk from 'aws-cdk-lib'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'

/**
 * The second mail provider's footprint (issue 156): Resend's DNS records for
 * both sending domains, and the secret its credentials live in.
 *
 * **Why a nested stack.** Seven resources, and CLAUDE.md's rule is that a
 * feature costing more than about five gets its own nested stack rather
 * than a slice of the parent's budget (the LogRetention / Setup / Monitoring
 * pattern). It costs the parent one resource. Nothing here has a runtime
 * dependency on anything in the parent except the KMS key every platform
 * secret already shares, so it is also the right shape.
 *
 * **Why the records are literals.** Resend hands out the DKIM public key and
 * the Return-Path hosts once, when the domain is added to the account, and
 * there is no AWS-side API that could look them up at synth time. They are
 * public keys, not secrets. If the domains are ever re-created in Resend
 * the values change and this file must be updated with them - the domain
 * page in the Resend dashboard shows the current ones.
 *
 * **Coexistence with SES.** Both providers sign the same two domains. They
 * cannot collide: SES's Easy DKIM lives at `<token>._domainkey`, Resend's at
 * `resend._domainkey`; SES's custom MAIL FROM is `mail.` on the apex and
 * `bounce.send.` on the subdomain, Resend's Return-Path is `rs.` and
 * `rs.send.`. DMARC passes if ANY aligned DKIM signature verifies, so the
 * `_dmarc` record in the parent covers both without change.
 */
export interface EmailProviderStackProps extends cdk.NestedStackProps {
  hostedZoneId: string
  zoneName: string
  /** The platform secrets key, so the Resend credentials sit beside Stripe's. */
  secretsKey: kms.IKey
}

/** From the Resend dashboard for makerbay.app, added 2026-09-08. */
const DKIM_APEX =
  'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC66ZWynHeLsPr99Qpe7S6dOePwhp1bXBATuD4pQQRqiJH3cOUTTKzx+mjPVpuJyPZUwxLRKrNUPUG25Lo2XJMwjXRCEYcr5ubcBeTXKL9gmfQDriE5orV4av/6FEGDaXu4WAJ7MG+F1yijyyW6dUp8j6kIyhFQSIKoYULBLc6ilQIDAQAB'
/** From the Resend dashboard for send.makerbay.app, added 2026-09-08. */
const DKIM_SEND =
  'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC93hRXKtqKmYpEB+4tgg1oSuPSfF7mvG5M6n5kmFXR4U1UlWXScQtkd7QAIsjuBrZ1709oAwGhPHtSB8yu5YL4EH5aXWG4roN4EflMjEZKiTa/8BvnVUNxB4R0LERaD0/YhrQ98aP4SMZPWBBgO/o+o9JE9QnE0st34pQ7dHQBKwIDAQAB'

/**
 * Resend's Return-Path MX. Resend itself sends through SES in us-east-1,
 * which is why this host is Amazon's; it is Resend's account, not ours, and
 * the SES sandbox on our account has no bearing on it.
 */
const RETURN_PATH_MX = 'feedback-smtp.us-east-1.amazonses.com'
const RETURN_PATH_SPF = 'v=spf1 include:amazonses.com ~all'

export class EmailProviderStack extends cdk.NestedStack {
  /** Holds `apiKey` and `webhookSecret`. Created with placeholders; filled out of band. */
  readonly resendSecret: secretsmanager.ISecret

  constructor(scope: Construct, id: string, props: EmailProviderStackProps) {
    super(scope, id, props)

    const zone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.zoneName,
    })

    // One set per verified domain: DKIM, then the Return-Path MX and SPF.
    for (const [name, sub, dkim] of [
      ['Apex', '', DKIM_APEX],
      ['Send', 'send', DKIM_SEND],
    ] as const) {
      const at = (label: string) => (sub ? `${label}.${sub}` : label)
      new route53.TxtRecord(this, `ResendDkim${name}`, {
        zone,
        recordName: at('resend._domainkey'),
        values: [dkim],
        ttl: cdk.Duration.hours(1),
        comment: `Resend DKIM for ${sub ? `${sub}.` : ''}${props.zoneName} (issue 156)`,
      })
      new route53.MxRecord(this, `ResendReturnPathMx${name}`, {
        zone,
        recordName: at('rs'),
        values: [{ priority: 10, hostName: RETURN_PATH_MX }],
        ttl: cdk.Duration.hours(1),
        comment: `Resend Return-Path for ${sub ? `${sub}.` : ''}${props.zoneName} (issue 156)`,
      })
      new route53.TxtRecord(this, `ResendReturnPathSpf${name}`, {
        zone,
        recordName: at('rs'),
        values: [RETURN_PATH_SPF],
        ttl: cdk.Duration.hours(1),
        comment: `Resend Return-Path SPF for ${sub ? `${sub}.` : ''}${props.zoneName} (issue 156)`,
      })
    }

    // Same shape as makerbay/stripe: generated placeholders, real values set
    // out of band and never through a template or a log. Rotation is off for
    // the same reason - the key is rolled in the provider's dashboard.
    this.resendSecret = new secretsmanager.Secret(this, 'ResendSecret', {
      secretName: 'makerbay/resend',
      description: 'Resend API key and webhook signing secret for MakerBay transactional email',
      encryptionKey: props.secretsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ apiKey: 'REPLACE_ME', webhookSecret: 'REPLACE_ME' }),
        generateStringKey: 'placeholder',
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    new cdk.CfnOutput(this, 'ResendSecretArn', { value: this.resendSecret.secretArn })
  }
}
