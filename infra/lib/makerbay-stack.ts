import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as events from 'aws-cdk-lib/aws-events'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'

const repoRoot = path.join(__dirname, '..', '..')

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
    const fn = (name: string, entry: string, env: Record<string, string>) =>
      new NodejsFunction(this, name, {
        entry: path.join(repoRoot, entry),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: cdk.Duration.seconds(15),
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
    const assistantFn = fn('AssistantApiFn', 'modules/assistant/api/src/handler.ts', tableEnv)

    for (const t of [users, apiKeys, entitlements]) t.grantReadData(authorizerFn)
    for (const t of [tenants, users, apiKeys, entitlements, usage]) t.grantReadWriteData(coreFn)
    for (const t of [entitlements, usage]) t.grantReadData(assistantFn)
    bus.grantPutEventsTo(coreFn)
    bus.grantPutEventsTo(assistantFn)

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

    // DNS + certificate for makerbay.app attach here once registration
    // completes (custom domain for the API, CloudFront for web surfaces).

    // ── Outputs ──────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint })
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId })
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId })
  }
}
