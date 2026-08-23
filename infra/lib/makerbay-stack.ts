import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as bedrock from 'aws-cdk-lib/aws-bedrock'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as events from 'aws-cdk-lib/aws-events'
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
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
      TABLE_USERS: users.tableName,
      TABLE_APIKEYS: apiKeys.tableName,
      TABLE_ENTITLEMENTS: entitlements.tableName,
      TABLE_USAGE: usage.tableName,
      TABLE_GRANTS: grants.tableName,
      EVENT_BUS: bus.eventBusName,
    }

    const authorizerFn = fn('AuthorizerFn', 'packages/core-api/src/authorizer.ts', {
      ...tableEnv,
      USER_POOL_ID: userPool.userPoolId,
      USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
    })
    const coreFn = fn('CoreApiFn', 'packages/core-api/src/handler.ts', tableEnv)
    const assistantFn = fn(
      'AssistantApiFn',
      'modules/assistant/api/src/handler.ts',
      {
        ...tableEnv,
        TABLE_SOURCES: sources.tableName,
        TABLE_CONVERSATIONS: conversations.tableName,
        TABLE_ASSISTANT_CONFIG: assistantConfig.tableName,
        KNOWLEDGE_BUCKET: knowledgeBucket.bucketName,
        KB_ID: kb.attrKnowledgeBaseId,
        DS_ID: dataSource.attrDataSourceId,
        CHAT_MODEL_ID,
      },
      { timeoutSeconds: 29, memorySize: 512 },
    )
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
        KNOWLEDGE_BUCKET: knowledgeBucket.bucketName,
        KB_ID: kb.attrKnowledgeBaseId,
        DS_ID: dataSource.attrDataSourceId,
        CHAT_MODEL_ID,
      },
      { timeoutSeconds: 29, memorySize: 512 },
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

    // ── Grants ───────────────────────────────────────────────────────────
    for (const t of [users, apiKeys, entitlements, grants]) t.grantReadData(authorizerFn)
    for (const t of [tenants, users, apiKeys, entitlements, grants, usage]) t.grantReadWriteData(coreFn)
    bus.grantPutEventsTo(coreFn)

    for (const t of [sources, conversations, assistantConfig]) t.grantReadWriteData(assistantFn)
    for (const t of [users, tenants, apiKeys, entitlements, grants, usage]) t.grantReadData(assistantFn)
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

    // ── API ──────────────────────────────────────────────────────────────
    const httpApi = new apigwv2.HttpApi(this, 'Api', {
      apiName: 'makerbay',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['authorization', 'content-type'],
      },
    })

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
    const siteDistribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
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
