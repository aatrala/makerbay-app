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
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
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
    const users = table('Users', 'userId')
    const apiKeys = table('ApiKeys', 'tenantId', 'keyId')
    apiKeys.addGlobalSecondaryIndex({
      indexName: 'byHash',
      partitionKey: { name: 'keyHash', type: dynamodb.AttributeType.STRING },
    })
    const entitlements = table('Entitlements', 'tenantId')
    const usage = table('Usage', 'pk', 'sk')
    const sources = table('Sources', 'tenantId', 'sourceId')
    const conversations = table('Conversations', 'pk', 'sk')
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
    const usageAggregatorFn = fn('UsageAggregatorFn', 'packages/core-api/src/usage-aggregator.ts', {
      TABLE_USAGE: usage.tableName,
    })

    // Metering pipeline: module usage events -> aggregator -> Usage table
    new events.Rule(this, 'UsageRule', {
      eventBus: bus,
      eventPattern: { detailType: ['usage'] },
      targets: [new eventsTargets.LambdaFunction(usageAggregatorFn)],
    })

    // ── Grants ───────────────────────────────────────────────────────────
    for (const t of [users, apiKeys, entitlements]) t.grantReadData(authorizerFn)
    for (const t of [tenants, users, apiKeys, entitlements, usage]) t.grantReadWriteData(coreFn)
    bus.grantPutEventsTo(coreFn)

    for (const t of [sources, conversations, assistantConfig]) t.grantReadWriteData(assistantFn)
    for (const t of [entitlements, usage]) t.grantReadData(assistantFn)
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

    usage.grantReadWriteData(usageAggregatorFn)

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

    httpApi.addRoutes({
      path: '/v1/core/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new HttpLambdaIntegration('CoreIntegration', coreFn),
      authorizer,
    })
    httpApi.addRoutes({
      path: '/v1/assistant/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new HttpLambdaIntegration('AssistantIntegration', assistantFn),
      authorizer,
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

    // ── Outputs ──────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint })
    new cdk.CfnOutput(this, 'ApiCustomUrl', { value: `https://api.${DOMAIN}` })
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId })
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId })
    new cdk.CfnOutput(this, 'KnowledgeBaseId', { value: kb.attrKnowledgeBaseId })
    new cdk.CfnOutput(this, 'DataSourceId', { value: dataSource.attrDataSourceId })
  }
}
