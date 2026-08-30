import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as bedrock from 'aws-cdk-lib/aws-bedrock'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as events from 'aws-cdk-lib/aws-events'
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as ses from 'aws-cdk-lib/aws-ses'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3n from 'aws-cdk-lib/aws-s3-notifications'
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources'
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { authEmail } from '@makerbay/email'
import { MonitoringStack } from './monitoring-stack'
import { LogRetentionStack } from './log-retention-stack'
import { SetupStack } from './setup-stack'

const repoRoot = path.join(__dirname, '..', '..')

const DOMAIN = 'makerbay.app'
const HOSTED_ZONE_ID = 'Z0426429227N069XCDM8M'
const EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'
const CHAT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'

/**
 * Whether SES has been granted production access (issue 76).
 *
 * This gates one thing: who sends Cognito's sign-up and password-reset codes.
 * While it is false those go through Cognito's own sender, because the SES
 * sandbox authorises the recipient and a new customer is never a verified
 * identity - see the comment on the user pool below for what that cost us.
 *
 * Verify before flipping, do not assume:
 *   aws sesv2 get-account --profile makerbay --query ProductionAccessEnabled
 */
const SES_LEFT_THE_SANDBOX = false

export class MakerbayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // ── Events ───────────────────────────────────────────────────────────
    // Usage metering + module event bus. The event schema is a stable
    // contract: { tenantId, moduleId, metric, quantity, idempotencyKey, ts }
    const bus = new events.EventBus(this, 'Bus', { eventBusName: 'makerbay' })

    // ── Data ─────────────────────────────────────────────────────────────
    // All items are tenant-scoped. Tables are RETAINed: a stack teardown
    // must never delete tenant data.
    const table = (name: string, pk: string, sk?: string) =>
      new dynamodb.Table(this, name, {
        tableName: `makerbay-${name.toLowerCase()}`,
        partitionKey: { name: pk, type: dynamodb.AttributeType.STRING },
        ...(sk ? { sortKey: { name: sk, type: dynamodb.AttributeType.STRING } } : {}),
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      })

    const tenants = table('Tenants', 'tenantId')
    tenants.addGlobalSecondaryIndex({
      indexName: 'bySlug',
      partitionKey: { name: 'slug', type: dynamodb.AttributeType.STRING },
    })
    // Page-settings snapshots (issue 45): one row per save, newest 20 kept.
    const presenceVersions = table('PresenceVersions', 'tenantId', 'sk')
    // Undo for the other surfaces an agent can write - booking hours, service
    // prices, assistant settings. Presence has had snapshots since issue 45;
    // these had neither a trail nor a way back (issue 99).
    const configVersions = table('ConfigVersions', 'pk', 'sk')
    // What happened to each email after SES took it, plus a per-tenant
    // address status (issue 107). Per-tenant on purpose: provider suppression
    // is account-wide, so one tenant's bounce would otherwise silence that
    // address for every other tenant.
    const mailLog = table('MailLog', 'tenantId', 'messageId')
    mailLog.addGlobalSecondaryIndex({
      indexName: 'byRef',
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'refKey', type: dynamodb.AttributeType.STRING },
    })
    // Support tickets (issue 49): customers write in-app, staff answer in
    // the console, email carries the notifications both ways.
    const tickets = table('Tickets', 'tenantId', 'ticketId')
    // Extra public addresses that 301 to the primary slug. Redirect, never
    // serve: two URLs carrying the same page would read as duplicate content
    // to Google and hurt the local SEO the page exists for.
    /**
     * Counters for public endpoints that need a ceiling (issue 119 review).
     *
     * Bespoke rather than the shared `table()` helper because these rows are
     * pure ephemera: they must expire on their own, and none of them is worth
     * a point-in-time backup or surviving a stack teardown.
     */
    const rateLimit = new dynamodb.Table(this, 'RateLimit', {
      tableName: 'makerbay-ratelimit',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    const slugAliases = table('SlugAliases', 'slug')
    slugAliases.addGlobalSecondaryIndex({
      indexName: 'byTenant',
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
    })
    const users = table('Users', 'userId')
    const apiKeys = table('ApiKeys', 'tenantId', 'keyId')
    apiKeys.addGlobalSecondaryIndex({
      indexName: 'byHash',
      partitionKey: { name: 'keyHash', type: dynamodb.AttributeType.STRING },
    })
    const entitlements = table('Entitlements', 'tenantId')
    // Grants: one item per entitlement grant, so the Stripe webhook writes a
    // single fixed sort key and can never overwrite a manually granted comp.
    const grants = table('Grants', 'tenantId', 'sk')
    // Usage carries two kinds of row: the daily counters, and short-lived
    // idempotency markers under their own partition so a redelivered metering
    // event cannot double-count (and so overbill through the Stripe meter).
    // The markers expire; the counters have no expiresAt and are unaffected.
    const usage = new dynamodb.Table(this, 'Usage', {
      tableName: 'makerbay-usage',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    const sources = table('Sources', 'tenantId', 'sourceId')
    const conversations = table('Conversations', 'pk', 'sk')
    // Inbox and insights read across every session for a tenant.
    conversations.addGlobalSecondaryIndex({
      indexName: 'byTenant',
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    })
    const assistantConfig = table('AssistantConfig', 'tenantId')
    // Contacts is core substrate: every module writes customer records here
    // rather than keeping its own list, so they can be joined up later.
    const contacts = table('Contacts', 'tenantId', 'contactId')
    contacts.addGlobalSecondaryIndex({
      indexName: 'byIdentity',
      partitionKey: { name: 'identityKey', type: dynamodb.AttributeType.STRING },
    })
    const contactEvents = table('ContactEvents', 'pk', 'sk')

    // Requests, Bookings, Quotes. Each attaches customers to Contacts rather
    // than keeping its own list, which is why Contacts had to come first.
    const requests = table('Requests', 'tenantId', 'requestId')
    const requestsConfig = table('RequestsConfig', 'tenantId')
    const bookingServices = table('BookingServices', 'tenantId', 'serviceId')
    const bookings = table('Bookings', 'tenantId', 'bookingId')
    // The diary and the double-booking check both need bookings by start time.
    bookings.addGlobalSecondaryIndex({
      indexName: 'byStart',
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startsAt', type: dynamodb.AttributeType.STRING },
    })
    const bookingConfig = table('BookingConfig', 'tenantId')
    const priceItems = table('PriceItems', 'tenantId', 'itemId')
    const quotes = table('Quotes', 'tenantId', 'quoteId')
    /**
     * Look a quote up by the token in a customer's link.
     *
     * Before this, the lookup queried by tenant with a FilterExpression and
     * Limit: 200. DynamoDB applies Limit BEFORE the filter, so it read the
     * first 200 quotes by id and searched inside them. Past 200 quotes a
     * tenant's newly issued links simply 404 - in production, on a link they
     * had already sent. An index makes it an exact lookup at any size.
     *
     * The token is the partition key, and it is 192 bits of randomness, so it
     * is globally unique without a tenant prefix. Callers still check the row's
     * tenantId matches, so a token cannot be replayed against another tenant.
     */
    quotes.addGlobalSecondaryIndex({
      indexName: 'byPublicToken',
      partitionKey: { name: 'publicToken', type: dynamodb.AttributeType.STRING },
    })
    const quotesConfig = table('QuotesConfig', 'tenantId')
    // Invoices are their own table with their own number series - INV-7 must
    // never repeat, and an invoice outlives the quote it came from.
    const invoices = table('Invoices', 'tenantId', 'invoiceId')
    // Same defect, same fix. The invoice list was ScanIndexForward: false, so
    // there it was the OLDER invoices that became unreachable.
    invoices.addGlobalSecondaryIndex({
      indexName: 'byPublicToken',
      partitionKey: { name: 'publicToken', type: dynamodb.AttributeType.STRING },
    })
    const reviews = table('Reviews', 'tenantId', 'reviewId')
    const reviewsConfig = table('ReviewsConfig', 'tenantId')
    // One row per Stripe Checkout attempt. The webhook flips pending to paid;
    // nothing else may.
    const payments = table('Payments', 'tenantId', 'paymentId')
    // Genie conversations: working memory, not records (the audit trail is
    // the record). TTL expires them after 90 days.
    const genieSessions = new dynamodb.Table(this, 'GenieSessions', {
      tableName: 'makerbay-geniesessions',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    // The workspace activity trail (tenant-facing; Genie's memory of what
    // happened). Partitioned per month like Usage; TTL keeps ~13 months.
    const audit = new dynamodb.Table(this, 'Audit', {
      tableName: 'makerbay-audit',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    // Presence stores only the editable words; services, hours and prices are
    // read live from the modules that own them, so nothing is stored twice.
    const presenceConfig = table('PresenceConfig', 'tenantId')
    // Presence Pro custom domains: the per-tenant distribution identifies the
    // tenant by request host, so the config must be findable by domain.
    presenceConfig.addGlobalSecondaryIndex({
      indexName: 'byDomain',
      partitionKey: { name: 'customDomain', type: dynamodb.AttributeType.STRING },
    })
    const visibilityConfig = table('VisibilityConfig', 'tenantId')
    // Missed-call rescue: the events table streams so the text goes out the
    // moment a call is answered, without slowing the call itself down.
    const rescueConfig = table('RescueConfig', 'tenantId')
    const rescueNumbers = table('RescueNumbers', 'phoneNumber')
    const rescueEvents = new dynamodb.Table(this, 'RescueEvents', {
      tableName: 'makerbay-rescueevents',
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'rescueId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // ── DNS + TLS ────────────────────────────────────────────────────────
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: DOMAIN,
    })
    const certificate = new acm.Certificate(this, 'Cert', {
      domainName: DOMAIN,
      subjectAlternativeNames: [`*.${DOMAIN}`],
      validation: acm.CertificateValidation.fromDns(zone),
    })

    // ── Email (SES) ──────────────────────────────────────────────────────
    // Requests, Bookings and Quotes all need to send mail, and domain
    // verification plus production access have a lead time measured in days,
    // so this is set up before the module that needs it.
    //
    // publicHostedZone() writes the DKIM CNAMEs and the MAIL FROM records for
    // us. A custom MAIL FROM subdomain means bounce handling and SPF align to
    // mail.makerbay.app and never touch whatever the apex uses for real mail.
    const publicZone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'PublicZone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: DOMAIN,
    })
    const emailConfigSet = new ses.ConfigurationSet(this, 'EmailConfigSet', {
      configurationSetName: 'makerbay-transactional',
      // Refuse to deliver rather than fall back to plaintext.
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
      reputationMetrics: true,
    })
    // Without this, SES raised bounce and complaint events and nothing
    // consumed them: notifyError caught only synchronous API failure, so a
    // message SES accepted and then hard-bounced left the row reading "sent"
    // and the dashboard's "email failed" chip could never fire (issue 107).
    // The DEFAULT bus, not `makerbay`: SES refuses any other. Our own bus
    // carries the usage-metering contract and this would have been a tidier
    // home, but the service does not allow it, so the rule below lives on the
    // default bus and filters on source instead.
    const defaultBus = events.EventBus.fromEventBusName(this, 'DefaultEventBus', 'default')
    emailConfigSet.addEventDestination('MailEvents', {
      destination: ses.EventDestination.eventBus(defaultBus),
      events: [
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.RENDERING_FAILURE,
        ses.EmailSendingEvent.DELIVERY_DELAY,
      ],
    })

    const emailIdentity = new ses.EmailIdentity(this, 'EmailIdentity', {
      identity: ses.Identity.publicHostedZone(publicZone),
      mailFromDomain: `mail.${DOMAIN}`,
      configurationSet: emailConfigSet,
    })
    /**
     * A separate sending domain for customer-bound mail (issue 103).
     *
     * A homeowner who marks a review request as spam should not be able to
     * damage the domain a tradesperson's PASSWORD RESET arrives from.
     * Receiving providers track reputation per domain, so the split is what
     * makes those two streams independent - one shared identity means one
     * annoyed customer of one plumber degrades delivery for every tenant.
     *
     * Its own identity with its own DKIM keys, not just a different address on
     * the same one, because that is what gives the subdomain a reputation of
     * its own rather than inheriting the parent's.
     *
     * NOTE: nothing sends from here until EMAIL_FROM_CUSTOMER is set, and that
     * is deliberately a SECOND deploy. Pointing customer mail at an identity
     * that has not finished verifying would fail every send - the same mistake
     * as shipping code before its index was ACTIVE.
     */
    const CUSTOMER_DOMAIN = `send.${DOMAIN}`
    const customerIdentity = new ses.EmailIdentity(this, 'CustomerEmailIdentity', {
      // Identity.domain, NOT publicHostedZone: the latter resolves to the
      // zone's own name and would declare a second identity for makerbay.app.
      // A subdomain needs its own identity, and therefore its own DKIM records
      // written into the parent zone by hand below.
      identity: ses.Identity.domain(CUSTOMER_DOMAIN),
      mailFromDomain: `bounce.${CUSTOMER_DOMAIN}`,
      configurationSet: emailConfigSet,
    })
    /**
     * The three Easy DKIM CNAMEs. Without these the identity never verifies
     * and every send from it fails.
     *
     * `recordName` is the part BELOW the zone, not the full name, and that
     * distinction is not cosmetic here. `dkimRecords[].name` is already
     * fully qualified - `<token>._domainkey.send.makerbay.app` - but it is a
     * CloudFormation token, so CDK cannot see at synth time that it already
     * ends with the zone name and appends the zone again. The first attempt
     * published
     *   <token>._domainkey.send.makerbay.app.makerbay.app
     * which resolves to nothing, so DKIM sat at PENDING while the MAIL FROM
     * records - which I had written by hand and were therefore correct -
     * reported SUCCESS. That split is what gave it away.
     *
     * Fn::Select pulls the bare token out of the front, and the rest is
     * literal, so what CDK appends lands in the right place.
     */
    customerIdentity.dkimRecords.forEach((r, i) => {
      const token = cdk.Fn.select(0, cdk.Fn.split('.', r.name))
      new route53.CnameRecord(this, `CustomerDkim${i + 1}`, {
        zone: publicZone,
        recordName: `${token}._domainkey.send`,
        domainName: r.value,
      })
    })
    /**
     * The custom MAIL FROM needs an MX so bounces come back to SES, and an SPF
     * TXT so the envelope domain passes. Both are what make DMARC align for
     * this subdomain the way they already do for the parent (issue 108).
     */
    new route53.MxRecord(this, 'CustomerMailFromMx', {
      zone: publicZone,
      recordName: `bounce.${CUSTOMER_DOMAIN}`,
      values: [{ priority: 10, hostName: `feedback-smtp.${this.region}.amazonses.com` }],
    })
    new route53.TxtRecord(this, 'CustomerMailFromSpf', {
      zone: publicZone,
      recordName: `bounce.${CUSTOMER_DOMAIN}`,
      values: ['v=spf1 include:amazonses.com ~all'],
    })
    new cdk.CfnOutput(this, 'CustomerEmailDomain', { value: CUSTOMER_DOMAIN })

    // Anything that sends mail gets this, rather than a blanket ses:* grant.
    const sesSendPolicy = new iam.PolicyStatement({
      // SESv2 SendEmail authorises against both actions depending on how the
      // message is composed, and the docs pair them everywhere. Granting only
      // ses:SendEmail produces an AccessDeniedException that says nothing.
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: [
        `arn:aws:ses:${this.region}:${this.account}:identity/${DOMAIN}`,
        // Customer-bound mail sends from the separate subdomain identity.
        `arn:aws:ses:${this.region}:${this.account}:identity/send.${DOMAIN}`,
        `arn:aws:ses:${this.region}:${this.account}:configuration-set/${emailConfigSet.configurationSetName}`,
      ],
    })
    /**
     * DMARC (issue 108).
     *
     * Without this record the anti-phishing promise the code emails make
     * ("nobody from MakerBay will ever ask you for this code") has no
     * technical substance: anyone could spoof makerbay.app and no receiver
     * would reject it. The claim and the enforcement have to ship together.
     *
     * Starting at p=none on purpose. It changes no delivery decision anywhere;
     * it only asks receivers to report what they see, which is the evidence
     * needed before tightening. Going straight to reject with an unproven
     * alignment story is how a launch loses every signup email silently.
     *
     * Alignment was verified before publishing this, not assumed:
     * DKIM signing is enabled and d=makerbay.app, and the custom MAIL FROM
     * mail.makerbay.app is SUCCESS with the right MX, so the envelope domain
     * shares an organisational domain with the From header. Relaxed alignment
     * on both (adkim/aspf default to r) therefore passes for SES mail,
     * including Cognito's, which now sends through this same identity.
     *
     * The separate Microsoft 365 SPF record on the apex covers human mail and
     * is unaffected: SPF is evaluated against the envelope domain, which for
     * SES is mail.makerbay.app.
     *
     * NOTE: aggregate reports go to dmarc@ on this domain. That mailbox or
     * alias has to exist for the reports to be readable. Reports are the whole
     * point of this stage, so without it there is no evidence to tighten on.
     */
    new route53.TxtRecord(this, 'DmarcRecord', {
      zone: publicZone,
      recordName: `_dmarc.${DOMAIN}`,
      values: [
        // One string. Route 53 splits at 255 characters on its own, and a
        // DMARC record broken across strings is read as two policies.
        `v=DMARC1; p=none; rua=mailto:dmarc@${DOMAIN}; ruf=mailto:dmarc@${DOMAIN}; fo=1; pct=100`,
      ],
      ttl: cdk.Duration.hours(1),
      comment: 'DMARC monitoring for issue 108. Ramp to quarantine then reject once reports are clean.',
    })

    new cdk.CfnOutput(this, 'EmailIdentityName', { value: emailIdentity.emailIdentityName })
    new cdk.CfnOutput(this, 'EmailConfigSetName', { value: emailConfigSet.configurationSetName })
    new cdk.CfnOutput(this, 'EmailFromAddress', { value: `hello@${DOMAIN}` })

    // ── Knowledge storage (assistant module) ─────────────────────────────
    const knowledgeBucket = new s3.Bucket(this, 'KnowledgeBucket', {
      bucketName: `makerbay-knowledge-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // S3 Vectors: cheapest managed vector store; supports the tenantId
    // equals-filter that enforces tenant isolation at retrieval time.
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: `makerbay-vectors-${this.account}`,
    })
    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName: vectorBucket.vectorBucketName!,
      indexName: 'knowledge',
      dataType: 'float32',
      dimension: 1024, // titan-embed-text-v2 default
      distanceMetric: 'cosine',
      metadataConfiguration: {
        // Chunk text must be non-filterable (filterable metadata is size-capped)
        nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT'],
      },
    })
    vectorIndex.addDependency(vectorBucket)

    // ── Knowledge Base ───────────────────────────────────────────────────
    const kbRole = new iam.Role(this, 'KbRole', {
      roleName: 'makerbay-kb-role',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*` },
        },
      }),
    })
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL}`],
      }),
    )
    knowledgeBucket.grantRead(kbRole)
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3vectors:PutVectors',
          's3vectors:GetVectors',
          's3vectors:DeleteVectors',
          's3vectors:QueryVectors',
          's3vectors:GetIndex',
        ],
        resources: [vectorIndex.attrIndexArn],
      }),
    )

    const kb = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: 'makerbay-knowledge',
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL}`,
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: { indexArn: vectorIndex.attrIndexArn },
      },
    })
    kb.node.addDependency(kbRole)
    kb.addDependency(vectorIndex)

    // Chunking is irreversible per data source: fixed-size 300 tokens / 15%
    // overlap suits docs/FAQ-style content. Changing means delete + recreate.
    const dataSource = new bedrock.CfnDataSource(this, 'KnowledgeDataSource', {
      knowledgeBaseId: kb.attrKnowledgeBaseId,
      name: 'knowledge-s3',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: knowledgeBucket.bucketArn,
          inclusionPrefixes: ['knowledge/'],
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: { maxTokens: 300, overlapPercentage: 15 },
        },
      },
    })
    dataSource.addDependency(kb)

    // ── Billing credentials ──────────────────────────────────────────────
    // Dedicated KMS key, usable only through Secrets Manager.
    const secretsKey = new kms.Key(this, 'SecretsKey', {
      alias: 'alias/makerbay-secrets',
      description: 'Encrypts MakerBay platform secrets',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    secretsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.AccountRootPrincipal()],
        actions: ['kms:GenerateDataKey', 'kms:Decrypt', 'kms:DescribeKey'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com` },
        },
      }),
    )

    // Created with generated placeholders — the real Stripe values are set
    // out of band and never pass through this template or any log.
    // Rotation is intentionally off: Stripe keys are rolled in the Stripe
    // dashboard, which no AWS rotation function can drive.
    const stripeSecret = new secretsmanager.Secret(this, 'StripeSecret', {
      secretName: 'makerbay/stripe',
      description: 'Stripe secret key and webhook signing secret for MakerBay billing',
      encryptionKey: secretsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ apiKey: 'REPLACE_ME', webhookSecret: 'REPLACE_ME' }),
        generateStringKey: 'placeholder',
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // ── Staff identity (separate from customers on purpose) ──────────────
    // A customer token fails signature validation against this pool, so admin
    // access cannot be reached by a claims check somebody forgot to add.
    const staffPool = new cognito.UserPool(this, 'StaffPool', {
      userPoolName: 'makerbay-staff',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 14, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    const staffClient = staffPool.addClient('AdminPortal', {
      authFlows: { userPassword: true, userSrp: true },
      accessTokenValidity: cdk.Duration.minutes(60),
      idTokenValidity: cdk.Duration.minutes(60),
      refreshTokenValidity: cdk.Duration.hours(8),
    })
    const staffDirectory = table('Staff', 'staffSub')
    const adminAudit = table('AdminAudit', 'pk', 'sk')

    // ── Identity ─────────────────────────────────────────────────────────
    // Cognito's own sender was the default until issue 104: mail arrived from
    // no-reply@verificationemail.com, a domain we do not own and cannot
    // authenticate, capped at 50 messages a day for the WHOLE AWS account and
    // shared with the staff pool. The two most security-sensitive emails in
    // the product were the two least trustworthy-looking, and a good launch
    // day would have silently stopped signups.
    //
    // Routing them through SES fixes the sender and the cap together, and the
    // templates come from packages/email at synth time, so the code email a
    // tradesperson gets cannot drift from the one telling them a customer
    // booked. renderEmail is pure, exactly like renderPage, which is what
    // makes calling it from CDK safe.
    const verifyMail = authEmail('verify')
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'makerbay',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      /*
       * Cognito's own sender, NOT SES, until SES leaves the sandbox
       * (issues 104, 137).
       *
       * Issue 104 moved these onto SES for a good reason: branded templates, a
       * real From address, and signup codes visible in the same bounce stream
       * as everything else. It also silently welded the front door shut.
       *
       * In the SES sandbox, SES authorises the RECIPIENT as well as the
       * sender, and a person signing up has by definition never been verified.
       * So every real signup got MessageRejected, the six-digit code was never
       * sent, and the account could never be confirmed. Proven against the
       * live account on 2026-08-29: sending to an unverified address returns
       * "Email address is not verified". Nobody could create an account
       * between 27 and 29 August.
       *
       * withCognito() has no such restriction. The cost is a no-reply From
       * address, no config-set visibility for auth mail, and a 50/day ceiling
       * instead of 200 - all of which are survivable, and none of which matter
       * if nobody can sign up. The branded templates are unaffected: the
       * userVerification block below and the CustomMessage trigger both still
       * apply.
       *
       * Flip SES_LEFT_THE_SANDBOX to true when production access is granted
       * (issue 76). Do not flip it hopefully - check with
       * `aws sesv2 get-account --query ProductionAccessEnabled`.
       */
      email: SES_LEFT_THE_SANDBOX
        ? cognito.UserPoolEmail.withSES({
            fromEmail: `hello@${DOMAIN}`,
            fromName: 'MakerBay',
            sesRegion: this.region,
            sesVerifiedDomain: DOMAIN,
            configurationSetName: emailConfigSet.configurationSetName,
          })
        : cognito.UserPoolEmail.withCognito(`hello@${DOMAIN}`),
      userVerification: {
        emailSubject: verifyMail.subject,
        emailBody: verifyMail.html,
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    const userPoolClient = userPool.addClient('Dashboard', {
      authFlows: { userPassword: true, userSrp: true },
    })

    // ── Functions ────────────────────────────────────────────────────────
    const fn = (
      name: string,
      entry: string,
      env: Record<string, string>,
      opts?: { timeoutSeconds?: number; memorySize?: number },
    ) =>
      (new NodejsFunction(this, name, {
        entry: path.join(repoRoot, entry),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: opts?.memorySize ?? 256,
        timeout: cdk.Duration.seconds(opts?.timeoutSeconds ?? 15),
        depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
        bundling: { minify: false, target: 'node22' },
        environment: env,
      }))

    const tableEnv = {
      TABLE_TENANTS: tenants.tableName,
      TABLE_SLUGALIASES: slugAliases.tableName,
      TABLE_USERS: users.tableName,
      TABLE_APIKEYS: apiKeys.tableName,
      TABLE_ENTITLEMENTS: entitlements.tableName,
      TABLE_USAGE: usage.tableName,
      TABLE_GRANTS: grants.tableName,
      TABLE_CONTACTS: contacts.tableName,
      TABLE_CONTACTEVENTS: contactEvents.tableName,
      EVENT_BUS: bus.eventBusName,
    }

    const authorizerFn = fn('AuthorizerFn', 'packages/core-api/src/authorizer.ts', {
      ...tableEnv,
      USER_POOL_ID: userPool.userPoolId,
      USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
    })
    // Cognito's `userVerification` above covers sign-up and nothing else.
    // Password reset, resend and the MFA code all ignore it, so the email
    // carrying a credential that can take over a workspace was arriving as
    // Cognito's unstyled default. This trigger routes every one of them
    // through the same templates (issue 107).
    const cognitoMessageFn = fn('CognitoMessageFn', 'packages/core-api/src/cognito-message.ts', {})
    userPool.addTrigger(cognito.UserPoolOperation.CUSTOM_MESSAGE, cognitoMessageFn)

    const coreFn = fn('CoreApiFn', 'packages/core-api/src/handler.ts', {
      ...tableEnv,
      TABLE_TICKETS: tickets.tableName,
      // Where new-ticket and reply notifications land (the founder's inbox).
      SUPPORT_EMAIL: 'aatrala@gmail.com',
      EMAIL_FROM: `hello@${DOMAIN}`,
      EMAIL_CONFIG_SET: emailConfigSet.configurationSetName,
    })
    coreFn.addToRolePolicy(sesSendPolicy)
    tickets.grantReadWriteData(coreFn)
    const contactsFn = fn('ContactsApiFn', 'modules/contacts/api/src/handler.ts', {
      ...tableEnv,
      /*
       * Erasing a person reaches across six modules (issue 133).
       *
       * contactId is written onto quotes, bookings, enquiries, reviews,
       * invoices and payments, so deleting only the contacts row left almost
       * everything behind while telling the owner the person was gone. The
       * cascade needs to see those tables to count them and to remove them.
       *
       * Invoices and payments are READ ONLY below, deliberately: they are
       * kept as tax records and the code refuses to delete them, so the IAM
       * should refuse too rather than trusting the code to keep its promise.
       */
      TABLE_QUOTES: quotes.tableName,
      TABLE_BOOKINGS: bookings.tableName,
      TABLE_REQUESTS: requests.tableName,
      TABLE_REVIEWS: reviews.tableName,
      TABLE_INVOICES: invoices.tableName,
      TABLE_PAYMENTS: payments.tableName,
    }, {
      // A CSV import writes one row at a time; give it room for a real list.
      timeoutSeconds: 29,
      memorySize: 512,
    })
    const moduleEnv = {
      ...tableEnv,
      EMAIL_FROM: `hello@${DOMAIN}`,
      EMAIL_CONFIG_SET: emailConfigSet.configurationSetName,
    }
    const requestsFn = fn('RequestsApiFn', 'modules/requests/api/src/handler.ts', {
      ...moduleEnv,
      TABLE_REQUESTS: requests.tableName,
      TABLE_REQUESTSCONFIG: requestsConfig.tableName,
    })
    // The free tier's morning lead summary (issue 50): one run a day at
    // 21:00 UTC - breakfast on the Australian east coast.
    const requestsDigestFn = fn('RequestsDigestFn', 'modules/requests/api/src/digest.ts', {
      ...moduleEnv,
      TABLE_REQUESTS: requests.tableName,
      TABLE_REQUESTSCONFIG: requestsConfig.tableName,
    }, { timeoutSeconds: 120 })
    new events.Rule(this, 'RequestsDigestRule', {
      ruleName: 'makerbay-requests-daily-digest',
      schedule: events.Schedule.cron({ minute: '0', hour: '21' }),
      targets: [new eventsTargets.LambdaFunction(requestsDigestFn)],
    })
    const bookingFn = fn('BookingApiFn', 'modules/booking/api/src/handler.ts', {
      ...moduleEnv,
      TABLE_BOOKINGSERVICES: bookingServices.tableName,
      TABLE_BOOKINGS: bookings.tableName,
      TABLE_BOOKINGCONFIG: bookingConfig.tableName,
      TABLE_CONFIGVERSIONS: configVersions.tableName,
      // A completed job asks for a review; a booking after a missed call
      // closes the rescued request and counts the conversion.
      TABLE_REQUESTS: requests.tableName,
      TABLE_VISIBILITYCONFIG: visibilityConfig.tableName,
    })
    const quotesFn = fn('QuotesApiFn', 'modules/quotes/api/src/handler.ts', {
      ...moduleEnv,
      TABLE_PRICEITEMS: priceItems.tableName,
      TABLE_QUOTES: quotes.tableName,
      TABLE_QUOTESCONFIG: quotesConfig.tableName,
      TABLE_INVOICES: invoices.tableName,
      // The business photo doubles as the document logo (issue 61b).
      TABLE_PRESENCECONFIG: presenceConfig.tableName,
    })
    const reviewsFn = fn('ReviewsApiFn', 'modules/reviews/api/src/handler.ts', {
      ...moduleEnv,
      TABLE_REVIEWS: reviews.tableName,
      TABLE_REVIEWSCONFIG: reviewsConfig.tableName,
      // The public respond page offers the Google link configured under
      // Get found, and the no-Reviews fallback ask reads the same config.
      TABLE_VISIBILITYCONFIG: visibilityConfig.tableName,
    })
    // Genie: the owner's read-everything copilot. Same chat model as the
    // assistant; its own session table; read-only views over the business.
    // "Set it up for me" lives in its own nested stack. CloudFormation caps a
    // stack at 500 resources and this one hit 509 the day the module first
    // tried to deploy (issue 111); a nested stack costs the parent ONE
    // resource and brings its own budget, so this module and everything phase
    // 3 adds grow without touching the parent's ceiling again.
    const setupStack = new SetupStack(this, 'Setup', {
      repoRoot,
      domain: DOMAIN,
      bus,
      readTables: {
        presenceConfig,
        bookingServices,
        assistantConfig,
        sources,
        quotesConfig,
        bookingConfig,
      },
      coreTableEnv: tableEnv,
      coreTables: [tenants, users, apiKeys, entitlements, grants, usage],
    })
    const setupFn = setupStack.handler

    const genieFn = fn('GenieApiFn', 'modules/genie/api/src/handler.ts', {
      ...tableEnv,
      TABLE_GENIESESSIONS: genieSessions.tableName,
      TABLE_AUDIT: audit.tableName,
      TABLE_BOOKINGS: bookings.tableName,
      TABLE_REQUESTS: requests.tableName,
      TABLE_QUOTES: quotes.tableName,
      TABLE_INVOICES: invoices.tableName,
      TABLE_PAYMENTS: payments.tableName,
      TABLE_REVIEWS: reviews.tableName,
      TABLE_BOOKINGSERVICES: bookingServices.tableName,
      // Timezone truth for "today"/"tomorrow" answers (issue 77).
      TABLE_BOOKINGCONFIG: bookingConfig.tableName,
      TABLE_PRESENCECONFIG: presenceConfig.tableName,
      TABLE_QUOTESCONFIG: quotesConfig.tableName,
      CHAT_MODEL_ID,
    }, { timeoutSeconds: 60, memorySize: 512 })

    const paymentsFn = fn('PaymentsApiFn', 'modules/payments/api/src/handler.ts', {
      ...moduleEnv,
      TABLE_PAYMENTS: payments.tableName,
      // Read-only views: payments validates what it charges for against the
      // documents that own the amounts.
      TABLE_INVOICES: invoices.tableName,
      TABLE_QUOTES: quotes.tableName,
      TABLE_QUOTESCONFIG: quotesConfig.tableName,
      TABLE_BOOKINGS: bookings.tableName,
      STRIPE_SECRET_ARN: stripeSecret.secretArn,
    }, { timeoutSeconds: 25 })
    // Fired by a one-off EventBridge schedule made when the booking is created.
    const reminderFn = fn('BookingReminderFn', 'modules/booking/api/src/reminder.ts', {
      ...moduleEnv,
      TABLE_BOOKINGS: bookings.tableName,
      TABLE_BOOKINGCONFIG: bookingConfig.tableName,
    })
    const reminderSchedulerRole = new iam.Role(this, 'ReminderSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    })
    reminderFn.grantInvoke(reminderSchedulerRole)
    const presenceFn = fn('PresenceApiFn', 'modules/presence/api/src/handler.ts', {
      ...tableEnv,
      TABLE_PRESENCECONFIG: presenceConfig.tableName,
      TABLE_PRESENCEVERSIONS: presenceVersions.tableName,
      TABLE_BOOKINGSERVICES: bookingServices.tableName,
      TABLE_BOOKINGCONFIG: bookingConfig.tableName,
      TABLE_ASSISTANT_CONFIG: assistantConfig.tableName,
      TABLE_REVIEWS: reviews.tableName,
      TABLE_VISIBILITYCONFIG: visibilityConfig.tableName,
      TABLE_QUOTESCONFIG: quotesConfig.tableName,
      // Genie-written page copy (spec in docs): one Converse call grounded
      // in the workspace's own knowledge base.
      CHAT_MODEL_ID,
      KB_ID: kb.attrKnowledgeBaseId,
    }, { timeoutSeconds: 25 })
    presenceFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:Retrieve'], resources: [kb.attrKnowledgeBaseArn] }),
    )
    presenceFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5*',
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5*`,
        ],
      }),
    )
    const visibilityFn = fn('VisibilityApiFn', 'modules/visibility/api/src/handler.ts', {
      ...moduleEnv,
      TABLE_VISIBILITYCONFIG: visibilityConfig.tableName,
    })
    // Call audio lives in its own bucket: greetings the Chime service reads,
    // recordings it writes, transcripts Transcribe writes. Never public.
    const rescueAudio = new s3.Bucket(this, 'RescueAudioBucket', {
      bucketName: `makerbay-rescue-audio-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        // Voicemail audio is raw personal data; the transcript is the record.
        { prefix: 'recordings/', expiration: cdk.Duration.days(30) },
        { prefix: 'transcripts/', expiration: cdk.Duration.days(90) },
      ],
    })
    // The Chime SDK media plane plays greetings and writes recordings itself.
    rescueAudio.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('voiceconnector.chime.amazonaws.com')],
      actions: ['s3:GetObject', 's3:PutObject', 's3:PutObjectAcl'],
      resources: [rescueAudio.arnForObjects('*')],
      conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
    }))

    const rescueEnv = {
      ...moduleEnv,
      TABLE_RESCUECONFIG: rescueConfig.tableName,
      TABLE_RESCUENUMBERS: rescueNumbers.tableName,
      TABLE_RESCUEEVENTS: rescueEvents.tableName,
      TABLE_REQUESTS: requests.tableName,
      RESCUE_AUDIO_BUCKET: rescueAudio.bucketName,
      CHAT_MODEL_ID,
    }
    // Answers the forwarded call. Must respond in well under a second, so it
    // does nothing but look up the tenant, log the call and return actions.
    const rescueSipFn = fn('RescueSipFn', 'modules/voice/api/src/sip-handler.ts', rescueEnv, {
      timeoutSeconds: 10,
    })
    rescueSipFn.addPermission('ChimeInvoke', {
      principal: new iam.ServicePrincipal('voiceconnector.chime.amazonaws.com'),
      sourceAccount: this.account,
    })
    // Chime SDK Voice has no CloudFormation support at all, so the SIP media
    // application, the phone number order and the SIP rule are one-time CLI
    // steps (documented in README) - like the phone number itself would be.
    new cdk.CfnOutput(this, 'RescueSipFnArn', { value: rescueSipFn.functionArn })

    // Everything slow: SMS, contact, request, transcription, extraction.
    const rescueProcessorFn = fn('RescueProcessorFn', 'modules/voice/api/src/processor.ts', rescueEnv, {
      timeoutSeconds: 120,
      memorySize: 512,
    })
    rescueProcessorFn.addEventSource(new lambdaEventSources.DynamoEventSource(rescueEvents, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 5,
      retryAttempts: 2,
    }))
    rescueAudio.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(rescueProcessorFn),
      { prefix: 'recordings/' },
    )
    rescueAudio.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(rescueProcessorFn),
      { prefix: 'transcripts/', suffix: '.json' },
    )
    rescueProcessorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['transcribe:StartTranscriptionJob'],
      resources: ['*'],
    }))
    rescueProcessorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }))

    // Owner config: greeting synthesis and the rescue log.
    const rescueApiFn = fn('RescueApiFn', 'modules/voice/api/src/handler.ts', rescueEnv, {
      timeoutSeconds: 29,
      memorySize: 512,
    })
    rescueApiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['polly:SynthesizeSpeech'],
      resources: ['*'],
    }))

    const assistantFn = fn(
      'AssistantApiFn',
      'modules/assistant/api/src/handler.ts',
      {
        ...tableEnv,
        TABLE_SOURCES: sources.tableName,
        TABLE_CONVERSATIONS: conversations.tableName,
        TABLE_ASSISTANT_CONFIG: assistantConfig.tableName,
        TABLE_CONFIGVERSIONS: configVersions.tableName,
        // Grounding: services, hours, areas and currency answerable with
        // zero uploaded documents.
        TABLE_BOOKINGSERVICES: bookingServices.tableName,
        TABLE_BOOKINGCONFIG: bookingConfig.tableName,
        TABLE_PRESENCECONFIG: presenceConfig.tableName,
        TABLE_QUOTESCONFIG: quotesConfig.tableName,
        KNOWLEDGE_BUCKET: knowledgeBucket.bucketName,
        KB_ID: kb.attrKnowledgeBaseId,
        DS_ID: dataSource.attrDataSourceId,
        CHAT_MODEL_ID,
      },
      { timeoutSeconds: 29, memorySize: 512 },
    )
    // Headless Chromium for JavaScript-drawn pages. Its own function because
    // the browser needs x86_64 (sparticuz ships no arm build), two gigabytes
    // and a cold start no API function should pay. Invoked by the assistant
    // only after every static extraction has come back empty.
    const scrapeRenderFn = new NodejsFunction(this, 'ScrapeRenderFn', {
      entry: path.join(repoRoot, 'modules/assistant/api/src/render-worker.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      memorySize: 2048,
      timeout: cdk.Duration.seconds(45),
      // A dedicated two-package lockfile: bundling runs npm ci against it,
      // and against the monorepo lock that would mean installing every
      // workspace's dependencies into the staging directory.
      projectRoot: repoRoot,
      depsLockFilePath: path.join(repoRoot, 'modules/assistant/api/render-deps/package-lock.json'),
      bundling: {
        minify: false,
        target: 'node22',
        // sparticuz/chromium is ESM-only, so the bundle must be ESM too; the
        // banner restores require() for the CommonJS packages it pulls in.
        format: OutputFormat.ESM,
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        // The Chromium binary cannot be inlined by esbuild - ship the real
        // packages in node_modules instead.
        nodeModules: ['@sparticuz/chromium', 'puppeteer-core'],
      },
    })
    assistantFn.addEnvironment('RENDER_FN_NAME', scrapeRenderFn.functionName)
    /*
     * The hero flow needs the renderer too (issue 146).
     *
     * Issue 43 taught the scraper to fall back to headless Chromium for pages
     * whose HTML arrives empty, and wired it to the assistant. The setup
     * module shipped later and never got it, so scrapePage there had no
     * fallback at all - and renderedFallback returns undefined the moment
     * RENDER_FN_NAME is unset, silently.
     *
     * The result: every JavaScript-built site pasted into the homepage came
     * back "there was not enough on that page to work from", which reads like
     * a judgement about their website rather than a missing capability of
     * ours. Reported for greenlightyourapp.com, the same site issue 43 was
     * originally about.
     */
    setupStack.handler.addEnvironment('RENDER_FN_NAME', scrapeRenderFn.functionName)
    scrapeRenderFn.grantInvoke(setupStack.handler)
    scrapeRenderFn.grantInvoke(assistantFn)
    // Streaming chat. API Gateway cannot stream a response, so this runs
    // behind a Lambda Function URL in RESPONSE_STREAM mode and is fronted by
    // CloudFront so it still answers on our own domain.
    const assistantStreamFn = fn(
      'AssistantStreamFn',
      'modules/assistant/api/src/chat-stream.ts',
      {
        ...tableEnv,
        TABLE_SOURCES: sources.tableName,
        TABLE_CONVERSATIONS: conversations.tableName,
        TABLE_ASSISTANT_CONFIG: assistantConfig.tableName,
        // Grounding: services, hours, areas and currency answerable with
        // zero uploaded documents.
        TABLE_BOOKINGSERVICES: bookingServices.tableName,
        TABLE_BOOKINGCONFIG: bookingConfig.tableName,
        TABLE_PRESENCECONFIG: presenceConfig.tableName,
        TABLE_QUOTESCONFIG: quotesConfig.tableName,
        KNOWLEDGE_BUCKET: knowledgeBucket.bucketName,
        KB_ID: kb.attrKnowledgeBaseId,
        DS_ID: dataSource.attrDataSourceId,
        CHAT_MODEL_ID,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      },
      { timeoutSeconds: 120, memorySize: 512 },
    )
    const streamUrl = assistantStreamFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    })

    // MCP server: the same modules, reachable by coding agents.
    const mcpFn = fn(
      'McpServerFn',
      'packages/mcp-server/src/handler.ts',
      {
        ...tableEnv,
        TABLE_SOURCES: sources.tableName,
        TABLE_CONVERSATIONS: conversations.tableName,
        TABLE_ASSISTANT_CONFIG: assistantConfig.tableName,
        // Grounding: services, hours, areas and currency answerable with
        // zero uploaded documents.
        TABLE_BOOKINGSERVICES: bookingServices.tableName,
        TABLE_BOOKINGCONFIG: bookingConfig.tableName,
        TABLE_PRESENCECONFIG: presenceConfig.tableName,
        TABLE_QUOTESCONFIG: quotesConfig.tableName,
        KNOWLEDGE_BUCKET: knowledgeBucket.bucketName,
        KB_ID: kb.attrKnowledgeBaseId,
        DS_ID: dataSource.attrDataSourceId,
        CHAT_MODEL_ID,
      },
      { timeoutSeconds: 29, memorySize: 512 },
    )

    const adminEnv = {
      ...tableEnv,
      TABLE_STAFF: staffDirectory.tableName,
      TABLE_ADMINAUDIT: adminAudit.tableName,
      // The tenant 360 and the conversation viewer read these; without the
      // names in env the reads fail silently into "unknown".
      TABLE_SOURCES: sources.tableName,
      TABLE_PRESENCECONFIG: presenceConfig.tableName,
      TABLE_CONVERSATIONS: conversations.tableName,
      TABLE_TICKETS: tickets.tableName,
      STAFF_POOL_ID: staffPool.userPoolId,
      STAFF_CLIENT_ID: staffClient.userPoolClientId,
    }
    const adminAuthorizerFn = fn('AdminAuthorizerFn', 'packages/admin-api/src/authorizer.ts', adminEnv)
    const adminApiFn = fn('AdminApiFn', 'packages/admin-api/src/handler.ts', {
      ...adminEnv,
      EMAIL_FROM: `hello@${DOMAIN}`,
      EMAIL_CONFIG_SET: emailConfigSet.configurationSetName,
      CUSTOMER_POOL_ID: userPool.userPoolId,
      // Ticket replies go through sendEmail with a ref, which runs the
      // pre-send suppression check against MailLog. Without the table name
      // that check throws, its catch fails open, and staff replies keep going
      // to addresses already known to bounce. (The nine module senders get
      // this in their shared loop below; adminApiFn is built from adminEnv,
      // which that loop does not cover.)
      TABLE_MAILLOG: mailLog.tableName,
    })
    mailLog.grantReadWriteData(adminApiFn)
    // Staff can send a test email so SES setup is verifiable rather than
    // merely declared. The first real sender will be the Requests module.
    adminApiFn.addToRolePolicy(sesSendPolicy)
    // Password resets send Cognito's own code to the user's mailbox; staff
    // never see or choose a password.
    adminApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminResetUserPassword'],
        resources: [userPool.userPoolArn],
      }),
    )

    const usageAggregatorFn = fn('UsageAggregatorFn', 'packages/core-api/src/usage-aggregator.ts', {
      TABLE_USAGE: usage.tableName,
    })

    const billingEnv = {
      ...tableEnv,
      STRIPE_SECRET_ARN: stripeSecret.secretArn,
      APP_URL: `https://app.${DOMAIN}`,
    }
    const billingFn = fn('BillingApiFn', 'packages/core-api/src/billing.ts', billingEnv, {
      timeoutSeconds: 25,
    })
    const billingWebhookFn = fn('BillingWebhookFn', 'packages/core-api/src/billing-webhook.ts', billingEnv, {
      timeoutSeconds: 25,
    })
    const billingReporterFn = fn('BillingReporterFn', 'packages/core-api/src/billing-reporter.ts', billingEnv, {
      timeoutSeconds: 120,
    })

    // Report metered usage to Stripe once a day.
    new events.Rule(this, 'BillingReportSchedule', {
      schedule: events.Schedule.cron({ minute: '20', hour: '3' }),
      targets: [new eventsTargets.LambdaFunction(billingReporterFn)],
    })

    // Metering pipeline: module usage events -> aggregator -> Usage table
    new events.Rule(this, 'UsageRule', {
      eventBus: bus,
      eventPattern: { detailType: ['usage'] },
      targets: [new eventsTargets.LambdaFunction(usageAggregatorFn)],
    })

    // Activity trail: explicit audit events plus the usage stream (which
    // already narrates the business) land in the audit table via one writer.
    const auditWriterFn = fn('AuditWriterFn', 'packages/core-api/src/audit-writer.ts', {
      TABLE_AUDIT: audit.tableName,
    })
    audit.grantWriteData(auditWriterFn)
    new events.Rule(this, 'AuditRule', {
      eventBus: bus,
      eventPattern: { detailType: ['audit', 'usage'] },
      targets: [new eventsTargets.LambdaFunction(auditWriterFn)],
    })
    // The dashboard's Activity feed reads it through core-api.
    coreFn.addEnvironment('TABLE_AUDIT', audit.tableName)
    audit.grantReadData(coreFn)

    // SES delivery events (issue 107). It reads contacts to mirror a bounce
    // onto the customer's record, and sends one email of its own: a bounce on
    // the OWNER's notification address is a silent product failure, because
    // they simply think no work is coming in.
    const mailEventsFn = fn('MailEventsFn', 'packages/core-api/src/mail-events.ts', {
      ...tableEnv,
      TABLE_MAILLOG: mailLog.tableName,
      // The module tables it writes the delivery outcome back onto. Named
      // explicitly rather than via tableEnv, because a missing one here is a
      // silent no-op in the registry, not a crash.
      TABLE_QUOTES: quotes.tableName,
      TABLE_INVOICES: invoices.tableName,
      TABLE_BOOKINGS: bookings.tableName,
      TABLE_REQUESTS: requests.tableName,
    })
    mailLog.grantReadWriteData(mailEventsFn)
    for (const t of [contacts, contactEvents]) t.grantReadWriteData(mailEventsFn)
    // It writes the delivery outcome back onto the row that caused the
    // message, because the dashboard's "email failed" chip reads that row and
    // not the log. Without this the pipeline records a bounce nobody sees.
    for (const t of [quotes, invoices, bookings, requests]) t.grantWriteData(mailEventsFn)

    /**
     * Every module that resolves a customer link by slug now goes through
     * getTenantBySlugOrAlias, so a workspace rename stops silently 404ing
     * links already in customers' messages (issue 118). That helper reads the
     * alias table, so each of these needs the name and the permission - a
     * missing one turns an unknown slug from a clean 404 into a 500.
     */
    for (const f of [quotesFn, bookingFn, requestsFn, assistantFn, reviewsFn]) {
      f.addEnvironment('TABLE_SLUGALIASES', slugAliases.tableName)
      slugAliases.grantReadData(f)
    }

    // The public document routes are the ones a stranger can reach.
    for (const f of [quotesFn]) {
      f.addEnvironment('TABLE_RATELIMIT', rateLimit.tableName)
      rateLimit.grantReadWriteData(f)
    }

    /**
     * The templated emails (issue 94) take a brand - the business name, their
     * colour and their photo - and getTenantBrand reads the presence row for
     * the last two. It lives in packages/core precisely so a module Lambda
     * asks for a brand rather than reaching into another module's table, but
     * the function still needs the name and the permission.
     */
    for (const f of [bookingFn, quotesFn, reviewsFn, requestsFn, visibilityFn, reminderFn]) {
      f.addEnvironment('TABLE_PRESENCECONFIG', presenceConfig.tableName)
      presenceConfig.grantReadData(f)
    }

    /**
     * Renders the HTML shell behind a quote or invoice link (issue 118).
     *
     * A SEPARATE function, not a route on quotesFn, and that is the whole
     * point. quotesFn holds read/write on the quotes and invoices tables;
     * putting the link-preview path inside it would mean every card render ran
     * in a role that can read any customer's price. This role can read the
     * tenant's name and nothing else, so the amount is unreachable at the AWS
     * authorization layer rather than by convention.
     *
     * The CloudFront function has already discarded the token by the time a
     * request arrives here, so this function is never even given the
     * credential that would identify a document.
     */
    /**
     * The unsubscribe endpoint (issue 121).
     *
     * Its own function, with read/write on the mail log and read on tenants
     * and nothing else: it is reachable by anyone holding a link from an
     * email, so the less it can touch the better.
     */
    const unsubscribeFn = fn('UnsubscribeFn', 'packages/core-api/src/unsubscribe-page.ts', {
      TABLE_MAILLOG: mailLog.tableName,
      TABLE_TENANTS: tenants.tableName,
      TABLE_CONTACTS: contacts.tableName,
      TABLE_CONTACTEVENTS: contactEvents.tableName,
    })
    mailLog.grantReadWriteData(unsubscribeFn)
    tenants.grantReadData(unsubscribeFn)
    // setEmailStatus mirrors the state onto the contact so the dashboard can
    // show it where the customer actually is.
    for (const t of [contacts, contactEvents]) t.grantReadWriteData(unsubscribeFn)

    const docShellFn = fn('DocShellFn', 'packages/core-api/src/doc-shell.ts', {
      TABLE_TENANTS: tenants.tableName,
      TABLE_SLUGALIASES: slugAliases.tableName,
    })
    tenants.grantReadData(docShellFn)
    slugAliases.grantReadData(docShellFn)
    // An explicit Deny, so a future blanket grant cannot quietly reopen what
    // the design promises is closed. Deny always wins in IAM evaluation.
    docShellFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:BatchGetItem'],
      resources: [quotes.tableArn, `${quotes.tableArn}/index/*`, invoices.tableArn, `${invoices.tableArn}/index/*`],
    }))
    for (const t of [users]) t.grantReadData(mailEventsFn)
    // Write, not read: the complaint auto-brake sets sendingRestrictedAt when
    // a workspace generates enough spam reports to threaten everybody else's
    // deliverability (issue 134).
    tenants.grantReadWriteData(mailEventsFn)
    mailEventsFn.addEnvironment('TABLE_TENANTS', tenants.tableName)
    mailEventsFn.addToRolePolicy(sesSendPolicy)
    new events.Rule(this, 'MailEventsRule', {
      // Default bus, because that is the only one SES will publish to. The
      // source filter is what keeps this rule from seeing every other AWS
      // event that lands there.
      eventBus: defaultBus,
      eventPattern: { source: ['aws.ses'] },
      targets: [new eventsTargets.LambdaFunction(mailEventsFn)],
    })
    // Every module that sends mail needs the pre-send check, which reads the
    // per-tenant address status out of this table.
    // Every function that calls sendEmail, including the scheduled ones: a
    // missing table here fails OPEN, so the reminder would keep writing to a
    // dead address and nothing would say why.
    for (const f of [
      bookingFn, quotesFn, requestsFn, reviewsFn, visibilityFn, coreFn,
      requestsDigestFn, reminderFn, rescueProcessorFn,
    ]) {
      f.addEnvironment('TABLE_MAILLOG', mailLog.tableName)
      mailLog.grantReadWriteData(f)
      /*
       * The daily send cap needs to know who is sending (issue 134).
       *
       * It reads the tenant for payoutsEnabled and the onboarding date, and
       * the grants to tell a paying or comped workspace from a new one. Read
       * only: the counter itself lives in MailLog, already granted above.
       *
       * These fail OPEN by design - a lookup error assumes a verified
       * workspace rather than cutting off a paying customer mid-day - so a
       * missing grant here would not break sending. It would silently switch
       * the cap off, which is worse, because everything would look fine.
       */
      f.addEnvironment('TABLE_TENANTS', tenants.tableName)
      f.addEnvironment('TABLE_ENTITLEMENTS', entitlements.tableName)
      f.addEnvironment('TABLE_GRANTS', grants.tableName)
      for (const t of [tenants, entitlements, grants]) t.grantReadData(f)
      /**
       * Customer-bound mail now leaves from its own domain (issue 103).
       *
       * A homeowner who marks a review request as spam damages the reputation
       * of send.makerbay.app, not of the domain a tradesperson's password
       * reset arrives from. Receivers track reputation per domain, so this
       * split is the whole point - and it is only safe to switch on now that
       * the identity reads SUCCESS for both DKIM and MAIL FROM.
       *
       * Owner-bound mail is untouched: sendEmail only reaches for this on the
       * customer branch, so notifications still arrive from hello@makerbay.app
       * as they always have.
       */
      f.addEnvironment('EMAIL_FROM_CUSTOMER', `hello@${CUSTOMER_DOMAIN}`)
    }

    // ── Grants ───────────────────────────────────────────────────────────
    // tenants: the authorizer refuses suspended workspaces (the kill switch).
    for (const t of [tenants, users, apiKeys, entitlements, grants]) t.grantReadData(authorizerFn)
    for (const t of [tenants, users, apiKeys, entitlements, grants, usage, slugAliases]) t.grantReadWriteData(coreFn)
    bus.grantPutEventsTo(coreFn)

    for (const t of [contacts, contactEvents]) t.grantReadWriteData(contactsFn)
    // The erasure cascade (issue 133). Write, because these are deleted with
    // the person.
    for (const t of [quotes, bookings, requests, reviews]) t.grantReadWriteData(contactsFn)
    // Read only. These are kept as tax records, so the role should not be able
    // to delete them even if a future bug asks it to.
    for (const t of [invoices, payments]) t.grantReadData(contactsFn)
    // Each module writes its own tables plus Contacts, and may send email.
    for (const f of [requestsFn, bookingFn, quotesFn]) {
      for (const t of [contacts, contactEvents, tenants, users, apiKeys, entitlements, grants]) {
        t.grantReadWriteData(f)
      }
      bus.grantPutEventsTo(f)
      f.addToRolePolicy(sesSendPolicy)
    }
    for (const t of [requests, requestsConfig]) t.grantReadWriteData(requestsFn)
    for (const t of [requests, requestsConfig, tenants, users, entitlements, grants]) t.grantReadData(requestsDigestFn)
    requestsDigestFn.addToRolePolicy(sesSendPolicy)
    for (const t of [bookingServices, bookings, bookingConfig, configVersions]) t.grantReadWriteData(bookingFn)
    for (const t of [priceItems, quotes, quotesConfig, invoices]) t.grantReadWriteData(quotesFn)
    // The business photo doubles as the document logo (issue 61b).
    presenceConfig.grantReadData(quotesFn)

    // Reviews: its own tables, Contacts, and the Get found config (read) for
    // the Google link and the fallback ask.
    for (const t of [reviews, reviewsConfig, contacts, contactEvents]) t.grantReadWriteData(reviewsFn)
    for (const t of [tenants, users, apiKeys, entitlements, grants]) t.grantReadData(reviewsFn)
    visibilityConfig.grantReadData(reviewsFn)
    bus.grantPutEventsTo(reviewsFn)
    reviewsFn.addToRolePolicy(sesSendPolicy)

    // The reminder Lambda reads the diary and emails the customer.
    for (const t of [bookings, bookingConfig, tenants, users]) t.grantReadData(reminderFn)
    bus.grantPutEventsTo(reminderFn)
    reminderFn.addToRolePolicy(sesSendPolicy)
    // Booking creates and deletes its own one-off reminder schedules. The
    // name prefix bounds it: this function manages rem-* and nothing else.
    bookingFn.addEnvironment('REMINDER_FN_ARN', reminderFn.functionArn)
    bookingFn.addEnvironment('SCHEDULER_ROLE_ARN', reminderSchedulerRole.roleArn)
    bookingFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule'],
      resources: [`arn:aws:scheduler:${this.region}:${this.account}:schedule/default/rem-*`],
    }))
    bookingFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [reminderSchedulerRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
    }))

    // A completed job is the moment to ask for a review.
    new events.Rule(this, 'BookingCompletedRule', {
      eventBus: bus,
      eventPattern: { source: ['makerbay.booking'], detailType: ['booking.completed'] },
      targets: [new eventsTargets.LambdaFunction(reviewsFn)],
    })

    // Genie: its sessions read-write; everything else read-only - v1 cannot
    // change a thing, and the IAM policy says so as loudly as the prompt.
    genieSessions.grantReadWriteData(genieFn)
    for (const t of [audit, bookings, requests, quotes, invoices, payments, reviews,
      bookingServices, bookingConfig, presenceConfig, quotesConfig, tenants, users, apiKeys, entitlements, grants, usage]) {
      t.grantReadData(genieFn)
    }
    bus.grantPutEventsTo(genieFn)
    genieFn.addToRolePolicy(new iam.PolicyStatement({
      // Same shape as the assistant: inference profiles fan out to models in
      // sibling regions, so scoping to one region's ARNs breaks silently.
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }))

    // Payments: its own table plus read-only views of the documents it
    // charges for, Contacts, the Stripe key, and the tenant row (Connect
    // state lives there).
    payments.grantReadWriteData(paymentsFn)
    for (const t of [invoices, quotes, quotesConfig]) t.grantReadData(paymentsFn)
    for (const t of [contacts, contactEvents, tenants]) t.grantReadWriteData(paymentsFn)
    for (const t of [users, apiKeys, entitlements, grants]) t.grantReadData(paymentsFn)
    bus.grantPutEventsTo(paymentsFn)
    stripeSecret.grantRead(paymentsFn)
    secretsKey.grantDecrypt(paymentsFn)
    // Stripe events, signature-verified by the billing webhook, arrive here.
    new events.Rule(this, 'StripeConnectEventsRule', {
      eventBus: bus,
      eventPattern: {
        source: ['makerbay.stripe'],
        detailType: ['stripe.checkout.completed', 'stripe.account.updated'],
      },
      targets: [new eventsTargets.LambdaFunction(paymentsFn)],
    })
    // Money landed - the quotes module makes its documents agree, and the
    // booking module confirms deposit-held slots (spec-booking-deposits.md).
    new events.Rule(this, 'PaymentReceivedRule', {
      eventBus: bus,
      eventPattern: { source: ['makerbay.payments'], detailType: ['payment.received'] },
      targets: [new eventsTargets.LambdaFunction(quotesFn), new eventsTargets.LambdaFunction(bookingFn)],
    })
    // The payments session endpoint resolves a held booking by its token.
    bookings.grantReadData(paymentsFn)
    presenceConfig.grantReadWriteData(presenceFn)
    presenceVersions.grantReadWriteData(presenceFn)
    visibilityConfig.grantReadWriteData(visibilityFn)
    for (const t of [tenants, users, entitlements, grants]) t.grantReadData(visibilityFn)
    contactEvents.grantReadWriteData(visibilityFn)
    contacts.grantReadWriteData(visibilityFn)
    bus.grantPutEventsTo(visibilityFn)
    visibilityFn.addToRolePolicy(sesSendPolicy)
    // Booking marks jobs done and closes rescued requests, so it needs both.
    visibilityConfig.grantReadData(bookingFn)
    requests.grantReadWriteData(bookingFn)

    for (const f of [rescueSipFn, rescueProcessorFn, rescueApiFn]) {
      for (const t of [rescueConfig, rescueNumbers, rescueEvents, tenants, users]) t.grantReadWriteData(f)
      rescueAudio.grantReadWrite(f)
    }
    for (const t of [contacts, contactEvents, requests, entitlements, grants]) {
      t.grantReadWriteData(rescueProcessorFn)
    }
    bus.grantPutEventsTo(rescueProcessorFn)
    rescueProcessorFn.addToRolePolicy(sesSendPolicy)
    // Read-only views: presence renders what other modules own, never writes it.
    for (const t of [bookingServices, bookingConfig, assistantConfig, reviews, visibilityConfig, quotesConfig, tenants, users, entitlements, grants, slugAliases]) {
      t.grantReadData(presenceFn)
    }
    // Copy drafting meters as Genie messages, so presence reads usage and
    // emits its own events.
    usage.grantReadData(presenceFn)
    /*
     * The pre-signup page preview (issue 145). The homepage says "get a page
     * back"; presence renders that page from the draft the setup module wrote,
     * so it needs read access to the draft and nothing else. Read only, and
     * the reader in packages/core returns only the fields a public renderer
     * needs - never the scraped excerpt.
     */
    setupStack.jobs.grantReadData(presenceFn)
    presenceFn.addEnvironment('TABLE_SETUPJOBS', setupStack.jobs.tableName)
    /*
     * First-party page counting (issue 145). The rate-limit table is a
     * generic (pk, sk) counter with a TTL, which is exactly the shape of a
     * daily page-view bucket; its name is about its first use, not its only
     * one. Reusing it costs no CloudFormation resource, which matters at 492
     * of a hard 500.
     */
    rateLimit.grantReadWriteData(presenceFn)
    presenceFn.addEnvironment('TABLE_RATELIMIT', rateLimit.tableName)
    bus.grantPutEventsTo(presenceFn)
    for (const t of [sources, conversations, assistantConfig, configVersions]) t.grantReadWriteData(assistantFn)
    for (const t of [users, tenants, apiKeys, entitlements, grants, usage]) t.grantReadData(assistantFn)
    // Grounding reads: what the workspace already knows about itself.
    for (const t of [bookingServices, bookingConfig, presenceConfig, quotesConfig]) t.grantReadData(assistantFn)
    bus.grantPutEventsTo(assistantFn)
    knowledgeBucket.grantReadWrite(assistantFn, 'knowledge/*')
    assistantFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:Retrieve', 'bedrock:StartIngestionJob', 'bedrock:GetIngestionJob', 'bedrock:ListIngestionJobs'],
        resources: [kb.attrKnowledgeBaseArn],
      }),
    )
    assistantFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5*',
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5*`,
        ],
      }),
    )

    for (const t of [sources, conversations, assistantConfig]) t.grantReadWriteData(assistantStreamFn)
    for (const t of [users, tenants, apiKeys, entitlements, grants, usage]) t.grantReadData(assistantStreamFn)
    // Grounding reads: what the workspace already knows about itself.
    for (const t of [bookingServices, bookingConfig, presenceConfig, quotesConfig]) t.grantReadData(assistantStreamFn)
    bus.grantPutEventsTo(assistantStreamFn)
    assistantStreamFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:Retrieve'], resources: [kb.attrKnowledgeBaseArn] }),
    )
    assistantStreamFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModelWithResponseStream', 'bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5*',
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5*`,
        ],
      }),
    )

    for (const t of [sources, conversations, assistantConfig]) t.grantReadWriteData(mcpFn)
    for (const t of [users, tenants, apiKeys, entitlements, grants, usage]) t.grantReadData(mcpFn)
    // Grounding reads: what the workspace already knows about itself.
    for (const t of [bookingServices, bookingConfig, presenceConfig, quotesConfig]) t.grantReadData(mcpFn)
    bus.grantPutEventsTo(mcpFn)
    knowledgeBucket.grantReadWrite(mcpFn, 'knowledge/*')
    mcpFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:Retrieve', 'bedrock:StartIngestionJob'],
        resources: [kb.attrKnowledgeBaseArn],
      }),
    )
    mcpFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5*',
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5*`,
        ],
      }),
    )

    for (const t of [tenants, users, apiKeys, entitlements, grants, usage, sources, conversations, presenceConfig]) {
      t.grantReadData(adminApiFn)
    }
    grants.grantReadWriteData(adminApiFn)
    tickets.grantReadWriteData(adminApiFn)
    // Suspend/unsuspend writes the tenant status field - nothing else.
    tenants.grantWriteData(adminApiFn)
    staffDirectory.grantReadData(adminAuthorizerFn)
    // PutItem plus Query only: the Lambda can append to and read its audit
    // trail but never rewrite or delete it.
    adminAudit.grant(adminApiFn, 'dynamodb:PutItem', 'dynamodb:Query')
    // SES suppression list: the answer to "why do my emails not arrive" for
    // one address, and the audited way off the list after a fixed bounce.
    adminApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ses:GetSuppressedDestination',
          'ses:ListSuppressedDestinations',
          'ses:DeleteSuppressedDestination',
        ],
        resources: ['*'],
      }),
    )

    usage.grantReadWriteData(usageAggregatorFn)

    for (const f of [billingFn, billingWebhookFn, billingReporterFn]) {
      stripeSecret.grantRead(f)
      secretsKey.grantDecrypt(f)
      tenants.grantReadWriteData(f)
      entitlements.grantReadWriteData(f)
      grants.grantReadWriteData(f)
      usage.grantReadData(f)
    }
    users.grantReadData(billingFn)
    // Connect events (checkout completed, account updated) travel the bus to
    // the payments module after signature verification.
    bus.grantPutEventsTo(billingWebhookFn)

    // ── API ──────────────────────────────────────────────────────────────
    const httpApi = new apigwv2.HttpApi(this, 'Api', {
      apiName: 'makerbay',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['authorization', 'content-type'],
      },
    })
    // Invisible abuse damping at zero cost (issue 47): stage-level throttling
    // caps any single burst well below where Bedrock or SES bills could
    // surprise, without a captcha in any customer's way. WAF + visible
    // CAPTCHA stay on owner hold until the abuse alarms actually fire.
    const defaultStage = httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage
    defaultStage.defaultRouteSettings = {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 100,
    }

    // The abuse tripwire (issue 47): when traffic or model usage jumps past
    // anything organic, the founder gets an email the same hour - and THAT is
    // the trigger to reach for WAF/CAPTCHA, not before.
    const abuseAlerts = new sns.Topic(this, 'AbuseAlerts', {
      topicName: 'makerbay-abuse-alerts',
      displayName: 'MakerBay abuse alerts',
    })
    abuseAlerts.addSubscription(new snsSubscriptions.EmailSubscription('aatrala@gmail.com'))
    const alarmEmail = new cloudwatchActions.SnsAction(abuseAlerts)

    const bedrockSpike = new cloudwatch.Alarm(this, 'BedrockInvocationSpike', {
      alarmName: 'makerbay-abuse-bedrock-invocations',
      alarmDescription: 'Bedrock invocations spiked past organic volume - possible chat or Genie abuse. Check WAF or CAPTCHA next.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Bedrock',
        metricName: 'Invocations',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 2000,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    bedrockSpike.addAlarmAction(alarmEmail)

    const apiSpike = new cloudwatch.Alarm(this, 'ApiRequestSpike', {
      alarmName: 'makerbay-abuse-api-requests',
      alarmDescription: 'API requests spiked past organic volume - possible scripted abuse of public endpoints.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: 'Count',
        dimensionsMap: { ApiId: httpApi.apiId },
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 50_000,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    apiSpike.addAlarmAction(alarmEmail)

    /*
     * Does the front door still open? (issue 145)
     *
     * Every alarm above watches spend or deliverability; none watches whether
     * a customer can do anything. Signup was broken for three days and found
     * by a code review. This signs up for real, every fifteen minutes.
     *
     * In a nested stack because it costs six resources and the parent is at
     * 492 of a hard 500 - a NestedStack costs the parent ONE and brings its
     * own budget, the pattern issue 111 established.
     */
    new MonitoringStack(this, 'Monitoring', {
      repoRoot,
      userPoolId: userPool.userPoolId,
      userPoolClientId: userPoolClient.userPoolClientId,
      userPoolArn: userPool.userPoolArn,
      alerts: abuseAlerts,
    })

    // Mail health (issue 107). Deliberately absolute counts, NOT the rate
    // metrics AWS suggests: at our volume a rate is noise. Ten sends and one
    // bounce is 10%, which would page every week for nothing; a hundred sends
    // and one complaint is 1%, ten times the 0.1% level at which SES starts a
    // review, and a rate alarm set to catch that would fire constantly. A count
    // answers the only question worth waking up for - is something systematic
    // happening - and it stays meaningful as volume grows.
    const bounceCount = new cloudwatch.Alarm(this, 'MailBounceCount', {
      alarmName: 'makerbay-mail-bounces',
      alarmDescription: 'More bounces in an hour than a normal day produces. Check for a bad import or a broken template before SES notices.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SES',
        metricName: 'Bounce',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    bounceCount.addAlarmAction(alarmEmail)

    // Lower, because complaints are what actually cost an account its sending.
    // Two in an hour is not a misclick.
    const complaintCount = new cloudwatch.Alarm(this, 'MailComplaintCount', {
      alarmName: 'makerbay-mail-complaints',
      alarmDescription: 'Two or more spam complaints in an hour. This is the metric that gets sending suspended - look at what went out.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SES',
        metricName: 'Complaint',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 2,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    complaintCount.addAlarmAction(alarmEmail)

    // The consumer failing is worse than any single bounce: bounces keep
    // arriving and are silently dropped, which is exactly the state issue 107
    // was filed to end.
    const mailEventsBroken = new cloudwatch.Alarm(this, 'MailEventsErrors', {
      alarmName: 'makerbay-mail-events-errors',
      alarmDescription: 'The SES event consumer is failing, so bounces are being discarded again. Check its logs.',
      metric: mailEventsFn.metricErrors({ period: cdk.Duration.hours(1), statistic: 'Sum' }),
      threshold: 3,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    mailEventsBroken.addAlarmAction(alarmEmail)

    const authorizer = new HttpLambdaAuthorizer('TenantAuthorizer', authorizerFn, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.Authorization'],
      resultsCacheTtl: cdk.Duration.minutes(5),
    })

    // Explicit methods only: an ANY route would also capture the OPTIONS
    // preflight and send it through the authorizer (401), breaking CORS.
    const M = apigwv2.HttpMethod
    const routeMethods = [
      apigwv2.HttpMethod.GET,
      apigwv2.HttpMethod.POST,
      apigwv2.HttpMethod.PUT,
      apigwv2.HttpMethod.DELETE,
      apigwv2.HttpMethod.PATCH,
    ]
    httpApi.addRoutes({
      path: '/v1/core/{proxy+}',
      methods: [M.GET, M.POST, M.DELETE, M.PATCH],
      integration: new HttpLambdaIntegration('CoreIntegration', coreFn),
      authorizer,
    })
    httpApi.addRoutes({
      path: '/v1/contacts',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('ContactsIntegration', contactsFn),
      authorizer,
    })
    httpApi.addRoutes({
      path: '/v1/contacts/{proxy+}',
      methods: [M.GET, M.POST, M.DELETE, M.PATCH],
      integration: new HttpLambdaIntegration('ContactsProxyIntegration', contactsFn),
      authorizer,
    })
    // Setup is registered on its own, authenticated only. The shared loop
    // below also creates /v1/public/<prefix>/* with no authorizer, which is
    // right for a booking page and wrong for a job that drives headless
    // Chromium and Bedrock. The stranger flow is phase 4 and needs per-IP and
    // per-email caps before it exists at all (docs/spec-concierge.md).
    // The ONE unauthenticated route in the setup module, and the most
    // expensive public thing the platform does: it fetches a stranger's web
    // page, may render it with headless Chromium, and calls Bedrock. POST
    // only, one exact path, never a proxy - a `{proxy+}` here would expose
    // every other setup route to the internet. Spend is bounded per IP and
    // globally per day in modules/setup/api/src/caps.ts, because the
    // platform-wide 50 req/s throttle is far too coarse to protect it.
    httpApi.addRoutes({
      path: '/v1/public/setup/draft',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('SetupPublicIntegration', setupFn),
    })
    /**
     * The document shell. Its own exact path, NOT under /v1/public/quotes,
     * because that whole prefix routes into the quotes handler - which would
     * put the preview back inside the function that can read prices.
     */
    httpApi.addRoutes({
      path: '/v1/public/doc/shell',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('DocShellIntegration', docShellFn),
    })
    /**
     * POST as well as GET: RFC 8058 one-click is a POST from the mail client
     * itself, and without it Gmail and Apple Mail show a plain link rather
     * than their own one-tap control - which is what the bulk-sender rules
     * actually ask for.
     */
    httpApi.addRoutes({
      path: '/v1/public/unsubscribe',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('UnsubscribeIntegration', unsubscribeFn),
    })
    httpApi.addRoutes({
      path: '/v1/setup/{proxy+}',
      // Only what the handler serves. Every method is a separate Route and a
      // separate Lambda permission, and this stack is close to
      // CloudFormation's 500-resource ceiling.
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('SetupProxyIntegration', setupFn),
      authorizer,
    })

    // Each handler is routed for the methods it actually serves and no more.
    // A route for an unserved method costs an API Gateway Route AND a Lambda
    // permission, and buys an invocation that returns 404. At 126 permissions
    // and 112 routes this is over half the stack (issue 111).
    const methodsFor: Record<string, apigwv2.HttpMethod[]> = {
      requests: [M.GET, M.POST, M.PUT, M.PATCH],
      booking: [M.GET, M.POST, M.PUT, M.DELETE, M.PATCH],
      quotes: [M.GET, M.POST, M.PUT, M.DELETE, M.PATCH],
      reviews: [M.GET, M.POST, M.PUT, M.PATCH],
      payments: [M.GET, M.POST],
    }
    for (const [name, prefix, handler] of [
      ['Requests', 'requests', requestsFn],
      ['Booking', 'booking', bookingFn],
      ['Quotes', 'quotes', quotesFn],
      ['Reviews', 'reviews', reviewsFn],
      ['Payments', 'payments', paymentsFn],
    ] as const) {
      const shared = new HttpLambdaIntegration(`${name}Integration`, handler)
      const methods = methodsFor[prefix] ?? routeMethods
      httpApi.addRoutes({
        path: `/v1/${prefix}`,
        methods,
        integration: shared,
        authorizer,
      })
      httpApi.addRoutes({
        path: `/v1/${prefix}/{proxy+}`,
        methods,
        integration: shared,
        authorizer,
      })
      // Public surfaces: the widget form, the booking page, the quote link.
      // No authorizer - the caller identifies a tenant with a publishable key
      // or a slug, and spend stays bounded by the tenant's plan limits.
      httpApi.addRoutes({
        path: `/v1/public/${prefix}/{proxy+}`,
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
        integration: new HttpLambdaIntegration(`Public${name}Integration`, handler),
      })
      httpApi.addRoutes({
        path: `/v1/public/${prefix}`,
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
        integration: new HttpLambdaIntegration(`Public${name}RootIntegration`, handler),
      })
    }

    // Only the methods each handler actually serves. A route for a method the
    // Lambda does not implement still costs an API Gateway Route AND a Lambda
    // permission, and buys an invocation that returns 404. This stack sits
    // close to CloudFormation's 500-resource ceiling (see issue 111).
    httpApi.addRoutes({
      path: '/v1/visibility/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST, apigwv2.HttpMethod.PUT],
      integration: new HttpLambdaIntegration('VisibilityIntegration', visibilityFn),
      authorizer,
    })
    httpApi.addRoutes({
      path: '/v1/voice/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT],
      integration: new HttpLambdaIntegration('RescueIntegration', rescueApiFn),
      authorizer,
    })
    httpApi.addRoutes({
      path: '/v1/presence/{proxy+}',
      methods: [M.GET, M.POST, M.PUT, M.DELETE],
      integration: new HttpLambdaIntegration('PresenceIntegration', presenceFn),
      authorizer,
    })
    // The public page render. No authorizer: the slug identifies the tenant.
    // POST as well as GET: the page-view beacon arrives via
    // navigator.sendBeacon, which can only POST - a GET-only route rejected
    // every beacon at the gateway and the analytics counters stayed at zero.
    httpApi.addRoutes({
      path: '/v1/public/presence',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('PublicPresenceIntegration', presenceFn),
    })
    httpApi.addRoutes({
      path: '/v1/genie/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('GenieIntegration', genieFn),
      authorizer,
    })
    httpApi.addRoutes({
      path: '/v1/assistant/{proxy+}',
      methods: [M.GET, M.POST, M.PUT, M.DELETE],
      integration: new HttpLambdaIntegration('AssistantIntegration', assistantFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/v1/core/billing/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('BillingIntegration', billingFn),
      authorizer,
    })

    // Stripe posts here. No authorizer: the request is authenticated by its
    // signature, verified against the webhook signing secret.
    httpApi.addRoutes({
      path: '/v1/billing/webhook',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('BillingWebhookIntegration', billingWebhookFn),
    })

    httpApi.addRoutes({
      path: '/mcp',
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.GET, apigwv2.HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('McpIntegration', mcpFn),
      authorizer,
    })

    // Public surface for the embeddable widget and hosted chat page: no
    // authorizer. The caller identifies a tenant with a publishable key or a
    // workspace slug; spend stays bounded by the tenant's plan limits.
    httpApi.addRoutes({
      path: '/v1/public/assistant/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('PublicAssistantIntegration', assistantFn),
    })

    // api.makerbay.app -> HTTP API
    const apiDomain = new apigwv2.DomainName(this, 'ApiDomain', {
      domainName: `api.${DOMAIN}`,
      certificate,
    })
    new apigwv2.ApiMapping(this, 'ApiMapping', { api: httpApi, domainName: apiDomain })
    new route53.ARecord(this, 'ApiAlias', {
      zone,
      recordName: 'api',
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          apiDomain.regionalDomainName,
          apiDomain.regionalHostedZoneId,
        ),
      ),
    })

    // ── Dashboard hosting: app.makerbay.app ──────────────────────────────
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      bucketName: `makerbay-web-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      domainNames: [`app.${DOMAIN}`],
      certificate,
      // SPA routing: unknown paths fall through to index.html
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    })
    new route53.ARecord(this, 'AppAlias', {
      zone,
      recordName: 'app',
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    })

    // ── Embed surfaces: chat.makerbay.app + widget.makerbay.app ──────────
    // One bucket and distribution serve both: /widget.js is the loader
    // script, everything else falls through to the chat app.
    const embedBucket = new s3.Bucket(this, 'EmbedBucket', {
      bucketName: `makerbay-embed-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    // Presence hero photos live under p/{tenantId}/ in this bucket, served
    // publicly through the embed distribution at chat.makerbay.app. The Lambda
    // may write only that prefix.
    presenceFn.addEnvironment('PHOTO_BUCKET', embedBucket.bucketName)
    embedBucket.grantPut(presenceFn, 'p/*')
    embedBucket.grantRead(presenceFn, 'p/*')
    // Browsers PUT directly to the presigned URL, which needs bucket CORS.
    embedBucket.addCorsRule({
      allowedMethods: [s3.HttpMethods.PUT],
      allowedOrigins: [`https://app.${DOMAIN}`],
      allowedHeaders: ['content-type'],
      maxAge: 3600,
    })
    const embedDistribution = new cloudfront.Distribution(this, 'EmbedDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(embedBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      domainNames: [`chat.${DOMAIN}`, `widget.${DOMAIN}`],
      certificate,
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    })
    for (const [id, recordName] of [['ChatAlias', 'chat'], ['WidgetAlias', 'widget']] as const) {
      new route53.ARecord(this, id, {
        zone,
        recordName,
        target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(embedDistribution)),
      })
    }

    // ── Streaming endpoint: stream.makerbay.app ──────────────────────────
    // Caching must stay off and the response must not be buffered, or the
    // whole point of streaming is lost.
    const streamDistribution = new cloudfront.Distribution(this, 'StreamDistribution', {
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(streamUrl),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
      domainNames: [`stream.${DOMAIN}`],
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    })
    new route53.ARecord(this, 'StreamAlias', {
      zone,
      recordName: 'stream',
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(streamDistribution)),
    })

    // ── Marketing site: makerbay.app + www ───────────────────────────────
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `makerbay-site-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    // S3 with OAC serves keys literally, so /roadmap must be rewritten to
    // /roadmap/index.html. Without this every page except the apex 404s.
    const directoryIndex = new cloudfront.Function(this, 'SiteDirectoryIndex', {
      functionName: `makerbay-site-directory-index-${this.account}`,
      comment: 'Rewrites extensionless paths to their index.html',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request
  var uri = request.uri
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html'
  } else if (!uri.split('/').pop().includes('.')) {
    request.uri = uri + '/index.html'
  }
  return request
}
`),
    })
    // makerbay.app/p/{slug} is a business page rendered by the presence
    // Lambda. A viewer-request function maps the friendly path onto the API,
    // and the edge caches the HTML so a crawl never becomes a Lambda bill.
    const presenceRewrite = new cloudfront.Function(this, 'PresenceRewrite', {
      functionName: `makerbay-presence-rewrite-${this.account}`,
      comment: 'Maps makerbay.app/p/{slug} onto the public presence API',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request
  var parts = request.uri.split('/').filter(function (p) { return p.length > 0 })
  request.uri = '/v1/public/presence'
  var qs = {}
  if (parts.length > 1) qs.slug = { value: parts[1] }
  // Sub-pages (grow/storefront styles): /p/{slug}/faq and friends.
  if (parts.length > 2) qs.sub = { value: parts[2] }
  request.querystring = qs
  return request
}
`),
    })
    // On a Presence Pro custom domain every path is the page; the function
    // maps whatever was requested onto the API, carrying the host so the
    // Lambda knows which tenant owns the domain. Shared by every per-tenant
    // distribution the presence Lambda creates.
    const domainRewrite = new cloudfront.Function(this, 'PresenceDomainRewrite', {
      functionName: `makerbay-presence-domain-rewrite-${this.account}`,
      comment: 'Maps a custom presence domain onto the public presence API',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request
  var parts = request.uri.split('/').filter(function (p) { return p.length > 0 })
  request.uri = '/v1/public/presence'
  var qs = { domain: { value: event.request.headers.host.value } }
  // Sub-pages on a custom domain: yourbusiness.com/faq etc.
  if (parts.length > 0) qs.sub = { value: parts[0] }
  request.querystring = qs
  return request
}
`),
    })
    const presenceCachePolicy = new cloudfront.CachePolicy(this, 'PresenceCachePolicy', {
      cachePolicyName: `makerbay-presence-${this.account}`,
      defaultTtl: cdk.Duration.minutes(5),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.hours(24),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    })
    /**
     * The document host (issue 118 phase 2).
     *
     *   https://quote.makerbay.app/dunn-plumbing/Q-014/<token>
     *   https://invoice.makerbay.app/dunn-plumbing/INV-042/<token>
     *
     * Its own subdomains, deliberately:
     * - NOT app.makerbay.app, which holds the tradesperson's dashboard
     *   session. A page strangers open must not share an origin with it.
     * - NOT chat.makerbay.app, which is shared with the widget embedded in
     *   arbitrary third-party sites, and whose root namespace is already the
     *   chat page's.
     *
     * The kind lives in the host so it is the first thing a homeowner reads.
     */
    const docHeaders = new cloudfront.ResponseHeadersPolicy(this, 'DocHeaders', {
      responseHeadersPolicyName: `makerbay-doc-${this.account}`,
      securityHeadersBehavior: {
        // The accept button on this page records a contract. Without frame
        // protection the page can be iframed and that click stolen.
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        contentTypeOptions: { override: true },
        // Belt and braces on the token in the path: browsers already default
        // to strict-origin-when-cross-origin, but an explicit no-referrer
        // settles the question rather than relying on a default.
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        /**
         * The page builds its own HTML by concatenation and assigns innerHTML
         * in a dozen places (issue 119 review). Every value goes through an
         * escape helper, but CSP is the layer that survives one missed call -
         * and on this page a missed call reaches a document carrying a price,
         * a customer's name and a tradesperson's bank details.
         *
         * The allowances are exactly what the page uses and nothing more:
         * - script and style from chat.makerbay.app, where pages.js and
         *   chat.css are served. 'unsafe-inline' for style only, because the
         *   invoice themes are injected as a <style> block at render time.
         * - connect to api.makerbay.app, which is where the token goes.
         * - images from chat.makerbay.app (the business photo) and data: for
         *   anything inlined.
         * - frame-ancestors 'none' repeats the X-Frame-Options above, because
         *   modern browsers honour CSP and ignore the older header.
         */
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'none'",
            "script-src https://chat.makerbay.app",
            "style-src https://chat.makerbay.app 'unsafe-inline'",
            "img-src https://chat.makerbay.app data:",
            "connect-src https://api.makerbay.app",
            "form-action 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
          ].join('; '),
          override: true,
        },
      },
    })

    /**
     * Strips the token before the cache lookup.
     *
     * This is what makes the shell renderer structurally unable to leak a
     * price: it is never handed the credential, so no future edit to it can
     * read the document. It also keeps the token out of the cache key, so the
     * fiftieth link a tradesperson sends is a cache hit rather than a
     * guaranteed miss.
     *
     * The browser still has the token in location.pathname and sends it only
     * to api.makerbay.app, exactly as before.
     */
    const docRewrite = new cloudfront.Function(this, 'DocRewrite', {
      functionName: `makerbay-doc-rewrite-${this.account}`,
      comment: 'Maps a document link onto the shell API, discarding the token',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request
  var host = request.headers.host ? request.headers.host.value : ''
  var kind = host.indexOf('invoice') === 0 ? 'invoice' : 'quote'
  var parts = request.uri.split('/').filter(function (p) { return p.length > 0 })
  // /{slug}/{label}/{token} - only the slug survives into the origin request.
  request.uri = '/v1/public/doc/shell'
  request.querystring = {
    slug: { value: parts.length > 0 ? parts[0] : '' },
    kind: { value: kind },
  }
  return request
}
`),
    })
    const docCachePolicy = new cloudfront.CachePolicy(this, 'DocCachePolicy', {
      cachePolicyName: `makerbay-doc-${this.account}`,
      defaultTtl: cdk.Duration.minutes(5),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.hours(24),
      // Only what survives the rewrite, so the cache key is per business and
      // per kind - never per token.
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('slug', 'kind'),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    })
    const docDistribution = new cloudfront.Distribution(this, 'DocDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(`api.${DOMAIN}`),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: docCachePolicy,
        responseHeadersPolicy: docHeaders,
        functionAssociations: [
          { function: docRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      domainNames: [`quote.${DOMAIN}`, `invoice.${DOMAIN}`],
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: 'MakerBay quote and invoice links',
    })
    for (const [id, name] of [['QuoteAlias', 'quote'], ['InvoiceAlias', 'invoice']] as const) {
      new route53.ARecord(this, id, {
        zone: publicZone,
        recordName: `${name}.${DOMAIN}`,
        target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(docDistribution)),
      })
    }
    new cdk.CfnOutput(this, 'DocQuoteUrl', { value: `https://quote.${DOMAIN}` })

    const siteDistribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      additionalBehaviors: {
        '/p/*': {
          origin: new origins.HttpOrigin(`api.${DOMAIN}`),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: presenceCachePolicy,
          functionAssociations: [
            { function: presenceRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
      },
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          { function: directoryIndex, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      defaultRootObject: 'index.html',
      domainNames: [DOMAIN, `www.${DOMAIN}`],
      certificate,
      // S3 with OAC answers 403 for a missing key, so map both to the 404 page.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: '/404.html' },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/404.html' },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    })
    // Presence Pro custom domains: the Lambda builds per-tenant distributions
    // from these two shared pieces. Certificates are per-domain and DNS-owned
    // by the tenant, so nothing here is per-tenant.
    presenceFn.addEnvironment('DOMAIN_REWRITE_FN_ARN', domainRewrite.functionArn)
    presenceFn.addEnvironment('PRESENCE_CACHE_POLICY_ID', presenceCachePolicy.cachePolicyId)
    // Operator-only escape hatch: lets us run the custom-domain flow against
    // a subdomain in our own zone. Tenants can never claim makerbay.app names.
    presenceFn.addEnvironment('DOMAIN_TEST_ALLOW', 'demo.makerbay.app')
    presenceFn.addToRolePolicy(new iam.PolicyStatement({
      // ACM certificate lifecycle for tenant domains. Request has no resource
      // to scope to; Describe/Delete act on certs this account created.
      actions: ['acm:RequestCertificate', 'acm:DescribeCertificate', 'acm:DeleteCertificate', 'acm:AddTagsToCertificate'],
      resources: ['*'],
    }))
    presenceFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudfront:CreateDistribution', 'cloudfront:GetDistribution',
        'cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution',
        'cloudfront:TagResource',
      ],
      resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
    }))
    presenceFn.addToRolePolicy(new iam.PolicyStatement({
      // Attaching the shared viewer-request function to a new distribution.
      actions: ['cloudfront:GetFunction', 'cloudfront:DescribeFunction'],
      resources: [domainRewrite.functionArn],
    }))

    // Apex plus www both point at the marketing distribution.
    new route53.ARecord(this, 'ApexAlias', {
      zone,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(siteDistribution)),
    })
    new route53.ARecord(this, 'WwwAlias', {
      zone,
      recordName: 'www',
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(siteDistribution)),
    })

    // ── Help centre: help.makerbay.app/{slug} ────────────────────────────
    // Server-rendered by the assistant Lambda, not a client-side app: the
    // whole point is that search engines index these pages, and a page that
    // needs JavaScript to show its text indexes badly. CloudFront caches the
    // rendered HTML so a crawl does not become a Lambda bill.
    const helpRewrite = new cloudfront.Function(this, 'HelpRewrite', {
      functionName: `makerbay-help-rewrite-${this.account}`,
      comment: 'Maps help.makerbay.app/{slug}/{article} onto the public help API',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request
  var parts = request.uri.split('/').filter(function (p) { return p.length > 0 })
  var qs = {}

  if (parts.length === 0) {
    request.uri = '/v1/public/assistant/help'
    request.querystring = {}
    return request
  }
  if (parts.length === 1 && parts[0] === 'robots.txt') {
    qs.robots = { value: '1' }
  } else {
    qs.slug = { value: parts[0] }
    if (parts.length > 1) {
      if (parts[1] === 'sitemap.xml') qs.sitemap = { value: '1' }
      else if (parts[1] === 'robots.txt') qs.robots = { value: '1' }
      else qs.article = { value: parts[1] }
    }
  }
  request.uri = '/v1/public/assistant/help'
  request.querystring = qs
  return request
}
`),
    })
    const helpDistribution = new cloudfront.Distribution(this, 'HelpDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(`api.${DOMAIN}`),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // The slug and article live in the query string the function writes,
        // so they must be part of the cache key.
        cachePolicy: new cloudfront.CachePolicy(this, 'HelpCachePolicy', {
          cachePolicyName: `makerbay-help-${this.account}`,
          defaultTtl: cdk.Duration.minutes(5),
          minTtl: cdk.Duration.seconds(0),
          maxTtl: cdk.Duration.hours(24),
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
        }),
        functionAssociations: [
          { function: helpRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      domainNames: [`help.${DOMAIN}`],
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    })
    new route53.ARecord(this, 'HelpAlias', {
      zone,
      recordName: 'help',
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(helpDistribution)),
    })
    new cdk.CfnOutput(this, 'HelpUrl', { value: `https://help.${DOMAIN}` })
    new cdk.CfnOutput(this, 'HelpDistributionId', { value: helpDistribution.distributionId })

    // ── Staff console: admin.makerbay.app ────────────────────────────────
    // Separate origin from the customer dashboard so a bug there can never
    // reach staff-only routes, and separate from the marketing site so it is
    // never crawled.
    const adminBucket = new s3.Bucket(this, 'AdminBucket', {
      bucketName: `makerbay-admin-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    const adminDistribution = new cloudfront.Distribution(this, 'AdminDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(adminBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      domainNames: [`admin.${DOMAIN}`],
      certificate,
      // A single-page app: every route is served by index.html.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    })
    new route53.ARecord(this, 'AdminAlias', {
      zone,
      recordName: 'admin',
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(adminDistribution)),
    })
    new cdk.CfnOutput(this, 'AdminBucketName', { value: adminBucket.bucketName })
    new cdk.CfnOutput(this, 'AdminDistributionId', { value: adminDistribution.distributionId })
    new cdk.CfnOutput(this, 'AdminUrl', { value: `https://admin.${DOMAIN}` })

    // ── Admin API on its own gateway ─────────────────────────────────────
    const adminApi = new apigwv2.HttpApi(this, 'AdminApi', {
      apiName: 'makerbay-admin',
      corsPreflight: {
        allowOrigins: [`https://admin.${DOMAIN}`],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          // Removing an address from the suppression list is a DELETE, and
          // without it here the browser preflight fails before the request is
          // ever made (issue 131).
          apigwv2.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ['authorization', 'content-type'],
      },
    })
    adminApi.addRoutes({
      path: '/admin/v1/{proxy+}',
      /*
       * ANY, not a list (issue 131).
       *
       * This was [GET, POST] while the handler served a DELETE and the admin
       * console called it: "remove from the suppression list" - the documented
       * answer to "my customer never got the email" - was a dead button. The
       * request never reached the Lambda, so there was nothing in its logs
       * either.
       *
       * Listing methods here means every route has to be added in two places
       * and the second one is invisible when you forget it. The handler ends
       * in a 404 fallthrough and every method passes the same authorizer, so
       * ANY does not widen access - it moves the routing decision to the one
       * place that can see the whole route table. It also costs one
       * CloudFormation resource instead of two, which matters at 492 of 500.
       */
      methods: [apigwv2.HttpMethod.ANY],
      integration: new HttpLambdaIntegration('AdminIntegration', adminApiFn),
      authorizer: new HttpLambdaAuthorizer('StaffAuthorizer', adminAuthorizerFn, {
        responseTypes: [HttpLambdaResponseType.SIMPLE],
        identitySource: ['$request.header.Authorization'],
        resultsCacheTtl: cdk.Duration.minutes(1),
      }),
    })
    const adminDomain = new apigwv2.DomainName(this, 'AdminApiDomain', {
      domainName: `admin-api.${DOMAIN}`,
      certificate,
    })
    new apigwv2.ApiMapping(this, 'AdminApiMapping', { api: adminApi, domainName: adminDomain })
    new route53.ARecord(this, 'AdminApiAlias', {
      zone,
      recordName: 'admin-api',
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          adminDomain.regionalDomainName,
          adminDomain.regionalHostedZoneId,
        ),
      ),
    })

    // mcp.makerbay.app -> the same HTTP API
    const mcpDomain = new apigwv2.DomainName(this, 'McpDomain', {
      domainName: `mcp.${DOMAIN}`,
      certificate,
    })
    new apigwv2.ApiMapping(this, 'McpMapping', { api: httpApi, domainName: mcpDomain })
    new route53.ARecord(this, 'McpAlias', {
      zone,
      recordName: 'mcp',
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          mcpDomain.regionalDomainName,
          mcpDomain.regionalHostedZoneId,
        ),
      ),
    })

    // ── Outputs ──────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AdminApiUrl', { value: `https://admin-api.${DOMAIN}/admin/v1` })
    new cdk.CfnOutput(this, 'StaffPoolId', { value: staffPool.userPoolId })
    new cdk.CfnOutput(this, 'StaffClientId', { value: staffClient.userPoolClientId })
    new cdk.CfnOutput(this, 'McpUrl', { value: `https://mcp.${DOMAIN}/mcp` })
    new cdk.CfnOutput(this, 'StreamUrl', { value: `https://stream.${DOMAIN}` })
    new cdk.CfnOutput(this, 'StreamFunctionUrl', { value: streamUrl.url })
    new cdk.CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName })
    new cdk.CfnOutput(this, 'SiteDistributionId', { value: siteDistribution.distributionId })
    new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${DOMAIN}` })
    new cdk.CfnOutput(this, 'EmbedBucketName', { value: embedBucket.bucketName })
    new cdk.CfnOutput(this, 'EmbedDistributionId', { value: embedDistribution.distributionId })
    new cdk.CfnOutput(this, 'WebBucketName', { value: webBucket.bucketName })
    new cdk.CfnOutput(this, 'WebDistributionId', { value: distribution.distributionId })
    new cdk.CfnOutput(this, 'AppUrl', { value: `https://app.${DOMAIN}` })
    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint })
    new cdk.CfnOutput(this, 'ApiCustomUrl', { value: `https://api.${DOMAIN}` })
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId })
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId })
    new cdk.CfnOutput(this, 'KnowledgeBaseId', { value: kb.attrKnowledgeBaseId })
    new cdk.CfnOutput(this, 'StripeSecretArn', { value: stripeSecret.secretArn })
    new cdk.CfnOutput(this, 'WebhookUrl', { value: `https://api.${DOMAIN}/v1/billing/webhook` })
    new cdk.CfnOutput(this, 'DataSourceId', { value: dataSource.attrDataSourceId })

    /*
     * One API-invoke permission per function, not per route (issue 153 Step 1).
     *
     * CDK's HttpLambdaIntegration mints a route-scoped Lambda permission for
     * every route, so a function serving fourteen routes carried fourteen
     * near-identical permissions - 104 resources across the two APIs for 21
     * functions, in a stack four resources from CloudFormation's hard 500.
     *
     * This sweep removes them after every route is registered and adds ONE
     * permission per (function, API) pair, with SourceArn scoped to that
     * API's whole ARN (`.../<apiId>/*` - which also covers the authorizers'
     * `/authorizers/<id>` shape). The trust boundary is unchanged in
     * substance: the API's own route table already decides which requests
     * reach which function, and no cross-account or cross-API surface is
     * added. Permissions are stateless, so a revert is a plain redeploy.
     *
     * It must run AFTER the last addRoutes call, which is why it sits here
     * at the end of the constructor beside the log-retention sweep.
     */
    {
      const refIn = (resolved: unknown): string | undefined =>
        JSON.stringify(resolved).match(/"Ref":"([A-Za-z0-9]+)"/)?.[1]
      const getAttIn = (resolved: unknown): string | undefined =>
        JSON.stringify(resolved).match(/"Fn::GetAtt":\["([A-Za-z0-9]+)"/)?.[1]
      const apiByRef = new Map<string, apigwv2.HttpApi>(
        [httpApi, adminApi].map((a) => [refIn(this.resolve(a.apiId)) ?? '', a]),
      )
      const keep = new Map<string, { functionName: string; api: apigwv2.HttpApi; fnId: string }>()
      for (const c of this.node.findAll()) {
        if (!(c instanceof lambda.CfnPermission) || c.principal !== 'apigateway.amazonaws.com') continue
        const resolvedFn = this.resolve(c.functionName)
        const apiRef = refIn(this.resolve(c.sourceArn)) ?? ''
        const api = apiByRef.get(apiRef)
        if (!api) {
          // A permission for an API this sweep does not know would be
          // silently broken by removal - refuse loudly at synth instead.
          throw new Error(`API permission for unknown API (ref ${apiRef}) at ${c.node.path}`)
        }
        keep.set(`${apiRef}#${JSON.stringify(resolvedFn)}`, {
          functionName: c.functionName,
          api,
          fnId: getAttIn(resolvedFn) ?? refIn(resolvedFn) ?? `F${keep.size}`,
        })
        c.node.scope!.node.tryRemoveChild(c.node.id)
      }
      for (const { functionName, api, fnId } of keep.values()) {
        new lambda.CfnPermission(this, `ApiInvoke${api.node.id}${fnId}`, {
          action: 'lambda:InvokeFunction',
          functionName,
          principal: 'apigateway.amazonaws.com',
          sourceArn: `arn:${this.partition}:execute-api:${this.region}:${this.account}:${api.apiId}/*`,
        })
      }
    }

    /*
     * Twelve-month log retention, in infrastructure at last (issue 135).
     *
     * The privacy policy promises logs are kept twelve months and deleted.
     * That was true only because it had been applied by hand, with a note in
     * CLAUDE.md asking whoever added the next Lambda to remember - and a
     * published commitment that depends on somebody remembering is not a
     * commitment.
     *
     * It goes in a nested stack because CDK's logRetention prop costs one
     * resource per function, and thirty-odd of those against 493 of a hard
     * 500 is what forced the manual workaround in the first place. The nested
     * stack costs the parent ONE and brings its own budget.
     *
     * The list is a SWEEP of the finished construct tree, not an opt-in
     * wrapper. The first version collected functions through the fn() helper,
     * which quietly excluded anything built with a bare `new NodejsFunction`
     * - ScrapeRenderFn, which needs x86_64 and its own lockfile, was outside
     * the twelve-month promise on the day the sweep shipped. Walking the tree
     * covers every function in THIS stack however it was constructed; nested
     * stacks are excluded because they carry their own retention (see
     * setup-stack.ts and monitoring-stack.ts).
     */
    const everyFunction = this.node.findAll()
      .filter((c): c is lambda.Function => c instanceof lambda.Function)
      .filter((f) => cdk.Stack.of(f) === this)
    new LogRetentionStack(this, 'LogRetention', {
      functionNames: everyFunction.map((f) => f.functionName),
    })
  }
}
