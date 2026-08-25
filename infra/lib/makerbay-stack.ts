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

const repoRoot = path.join(__dirname, '..', '..')

const DOMAIN = 'makerbay.app'
const HOSTED_ZONE_ID = 'Z0426429227N069XCDM8M'
const EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'
const CHAT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'

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
    // Support tickets (issue 49): customers write in-app, staff answer in
    // the console, email carries the notifications both ways.
    const tickets = table('Tickets', 'tenantId', 'ticketId')
    // Extra public addresses that 301 to the primary slug. Redirect, never
    // serve: two URLs carrying the same page would read as duplicate content
    // to Google and hurt the local SEO the page exists for.
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
    const usage = table('Usage', 'pk', 'sk')
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
    const quotesConfig = table('QuotesConfig', 'tenantId')
    // Invoices are their own table with their own number series - INV-7 must
    // never repeat, and an invoice outlives the quote it came from.
    const invoices = table('Invoices', 'tenantId', 'invoiceId')
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
    const emailIdentity = new ses.EmailIdentity(this, 'EmailIdentity', {
      identity: ses.Identity.publicHostedZone(publicZone),
      mailFromDomain: `mail.${DOMAIN}`,
      configurationSet: emailConfigSet,
    })
    // Anything that sends mail gets this, rather than a blanket ses:* grant.
    const sesSendPolicy = new iam.PolicyStatement({
      // SESv2 SendEmail authorises against both actions depending on how the
      // message is composed, and the docs pair them everywhere. Granting only
      // ses:SendEmail produces an AccessDeniedException that says nothing.
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: [
        `arn:aws:ses:${this.region}:${this.account}:identity/${DOMAIN}`,
        `arn:aws:ses:${this.region}:${this.account}:configuration-set/${emailConfigSet.configurationSetName}`,
      ],
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
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'makerbay',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
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
      new NodejsFunction(this, name, {
        entry: path.join(repoRoot, entry),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: opts?.memorySize ?? 256,
        timeout: cdk.Duration.seconds(opts?.timeoutSeconds ?? 15),
        depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
        bundling: { minify: false, target: 'node22' },
        environment: env,
      })

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
    const contactsFn = fn('ContactsApiFn', 'modules/contacts/api/src/handler.ts', tableEnv, {
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
    })
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
    })
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

    // ── Grants ───────────────────────────────────────────────────────────
    // tenants: the authorizer refuses suspended workspaces (the kill switch).
    for (const t of [tenants, users, apiKeys, entitlements, grants]) t.grantReadData(authorizerFn)
    for (const t of [tenants, users, apiKeys, entitlements, grants, usage, slugAliases]) t.grantReadWriteData(coreFn)
    bus.grantPutEventsTo(coreFn)

    for (const t of [contacts, contactEvents]) t.grantReadWriteData(contactsFn)
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
    for (const t of [bookingServices, bookings, bookingConfig]) t.grantReadWriteData(bookingFn)
    for (const t of [priceItems, quotes, quotesConfig, invoices]) t.grantReadWriteData(quotesFn)

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
      bookingServices, presenceConfig, quotesConfig, tenants, users, apiKeys, entitlements, grants, usage]) {
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
    // Money landed - the quotes module makes its documents agree.
    new events.Rule(this, 'PaymentReceivedRule', {
      eventBus: bus,
      eventPattern: { source: ['makerbay.payments'], detailType: ['payment.received'] },
      targets: [new eventsTargets.LambdaFunction(quotesFn)],
    })
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
    for (const t of [sources, conversations, assistantConfig]) t.grantReadWriteData(assistantFn)
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

    const authorizer = new HttpLambdaAuthorizer('TenantAuthorizer', authorizerFn, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.Authorization'],
      resultsCacheTtl: cdk.Duration.minutes(5),
    })

    // Explicit methods only: an ANY route would also capture the OPTIONS
    // preflight and send it through the authorizer (401), breaking CORS.
    const routeMethods = [
      apigwv2.HttpMethod.GET,
      apigwv2.HttpMethod.POST,
      apigwv2.HttpMethod.PUT,
      apigwv2.HttpMethod.DELETE,
      apigwv2.HttpMethod.PATCH,
    ]
    httpApi.addRoutes({
      path: '/v1/core/{proxy+}',
      methods: routeMethods,
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
      methods: routeMethods,
      integration: new HttpLambdaIntegration('ContactsProxyIntegration', contactsFn),
      authorizer,
    })
    for (const [name, prefix, handler] of [
      ['Requests', 'requests', requestsFn],
      ['Booking', 'booking', bookingFn],
      ['Quotes', 'quotes', quotesFn],
      ['Reviews', 'reviews', reviewsFn],
      ['Payments', 'payments', paymentsFn],
    ] as const) {
      httpApi.addRoutes({
        path: `/v1/${prefix}`,
        methods: routeMethods,
        integration: new HttpLambdaIntegration(`${name}Integration`, handler),
        authorizer,
      })
      httpApi.addRoutes({
        path: `/v1/${prefix}/{proxy+}`,
        methods: routeMethods,
        integration: new HttpLambdaIntegration(`${name}ProxyIntegration`, handler),
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

    httpApi.addRoutes({
      path: '/v1/visibility/{proxy+}',
      methods: routeMethods,
      integration: new HttpLambdaIntegration('VisibilityIntegration', visibilityFn),
      authorizer,
    })
    httpApi.addRoutes({
      path: '/v1/voice/{proxy+}',
      methods: routeMethods,
      integration: new HttpLambdaIntegration('RescueIntegration', rescueApiFn),
      authorizer,
    })
    httpApi.addRoutes({
      path: '/v1/presence/{proxy+}',
      methods: routeMethods,
      integration: new HttpLambdaIntegration('PresenceIntegration', presenceFn),
      authorizer,
    })
    // The public page render. No authorizer: the slug identifies the tenant.
    httpApi.addRoutes({
      path: '/v1/public/presence',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('PublicPresenceIntegration', presenceFn),
    })
    httpApi.addRoutes({
      path: '/v1/genie/{proxy+}',
      methods: routeMethods,
      integration: new HttpLambdaIntegration('GenieIntegration', genieFn),
      authorizer,
    })
    httpApi.addRoutes({
      path: '/v1/assistant/{proxy+}',
      methods: routeMethods,
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
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        allowHeaders: ['authorization', 'content-type'],
      },
    })
    adminApi.addRoutes({
      path: '/admin/v1/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
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
  }
}
