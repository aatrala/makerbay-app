import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as sns from 'aws-cdk-lib/aws-sns'
import { Construct } from 'constructs'

/**
 * Customer authentication on Better Auth (issue 157, docs/spec-auth.md).
 *
 * **Why a nested stack.** A table, a function with its role and policy, a
 * log-retention custom resource, a secret and three routes is past the
 * ~5-resource rule for the parent, and this shares nothing with the rest
 * of the application except the API it mounts on and the mail pipeline it
 * sends codes through. It costs the parent one resource.
 *
 * **What stays in the parent.** The Cognito hosted domain and the upstream
 * app client hang off the retained user pool, so they are declared beside
 * it. The parent also decides `AUTH_PROVIDER`; this stack is deployed dark
 * either way, so the dark path can be tested before anything flips.
 *
 * **The table** mirrors `packages/auth/src/adapter/schema.ts`: one partition
 * key, three GSIs projecting everything, TTL on `ttl`. Change one and change
 * the other - the adapter tests build the table from schema.ts, so a drift
 * would pass the tests and fail in production.
 */
export interface AuthStackProps extends cdk.NestedStackProps {
  repoRoot: string
  /** The public HTTP API the auth routes mount on. */
  httpApi: apigwv2.IHttpApi
  /** `makerbay.app`; the API is `api.` and the dashboard `app.` under it. */
  domain: string
  secretsKey: kms.IKey
  userPool: cognito.IUserPool
  /** The public PKCE client Better Auth uses to sign in through Cognito. */
  upstreamClient: cognito.IUserPoolClient
  /** Which upstream providers to enable, e.g. ['cognito']. */
  upstreams: string[]
  /** Where a failed sign-in code goes. The same topic the abuse alarms use. */
  alerts: sns.ITopic
  /** Everything a function needs to send mail through the platform pipeline. */
  mail: {
    provider: string
    from: string
    configSetName: string
    resendSecret: secretsmanager.ISecret
    sesSendPolicy: iam.PolicyStatement
  }
}

const GSI_NAMES = ['gsi1', 'gsi2', 'gsi3'] as const

export class AuthStack extends cdk.NestedStack {
  readonly handler: NodejsFunction
  readonly table: dynamodb.Table
  readonly secret: secretsmanager.ISecret

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props)

    const table = new dynamodb.Table(this, 'AuthTable', {
      tableName: 'makerbay-auth',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    for (const g of GSI_NAMES) {
      table.addGlobalSecondaryIndex({
        indexName: g,
        partitionKey: { name: `${g}pk`, type: dynamodb.AttributeType.STRING },
        sortKey: { name: `${g}sk`, type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      })
    }

    // Generated once, read by the function, seen by nobody. Rotating it
    // signs everyone out, which is the documented way to do that.
    const secret = new secretsmanager.Secret(this, 'AuthSecret', {
      secretName: 'makerbay/auth',
      description: 'Better Auth signing secret for MakerBay customer sign-in',
      encryptionKey: props.secretsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'secret',
        passwordLength: 64,
        excludePunctuation: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    const apiUrl = `https://api.${props.domain}`
    const fn = new NodejsFunction(this, 'AuthFn', {
      entry: path.join(props.repoRoot, 'packages/auth/src/handler.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // Better Auth plus jose is a heavier bundle than the module Lambdas;
      // more memory is also more CPU, and cold starts are what a sign-in
      // page feels.
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      depsLockFilePath: path.join(props.repoRoot, 'package-lock.json'),
      bundling: { minify: false, target: 'node22' },
      environment: {
        TABLE_AUTH: table.tableName,
        AUTH_SECRET_ARN: secret.secretArn,
        /*
         * Public URL of the auth endpoints: the dashboard's origin, where
         * /auth/* is proxied to this API so cookies are first-party (issue
         * 158). The token issuer is separate and deliberately stays on api.:
         * it is an opaque identifier the authorizer compares against, and
         * moving it with the base URL would reject every token in flight.
         */
        AUTH_BASE_URL: `https://app.${props.domain}`,
        AUTH_ISSUER: apiUrl,
        AUTH_SPA_URL: `https://app.${props.domain}`,
        // Passkeys bind to this for life (issue 158 part B1): the apex, so
        // one credential covers app. and any future host.
        AUTH_RP_ID: props.domain,
        AUTH_UPSTREAMS: props.upstreams.join(','),
        COGNITO_ISSUER: `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
        COGNITO_UPSTREAM_CLIENT_ID: props.upstreamClient.userPoolClientId,
        EMAIL_FROM: props.mail.from,
        EMAIL_PROVIDER: props.mail.provider,
        EMAIL_CONFIG_SET: props.mail.configSetName,
        RESEND_SECRET_ARN: props.mail.resendSecret.secretArn,
      },
    })
    table.grantReadWriteData(fn)
    /*
     * Secret access on the function's OWN role, never via `grantRead`. That
     * helper also writes the grantee into the KMS key's resource policy, and
     * the key lives in the parent: the parent's key would then depend on
     * this stack's role while this stack depends on the parent's API - a
     * cycle CloudFormation refuses. The key policy already delegates to
     * account IAM (AccountRootPrincipal, via Secrets Manager), so an
     * identity policy is sufficient and is what the parent's own Lambdas
     * effectively rely on too.
     */
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [secret.secretArn, props.mail.resendSecret.secretArn],
    }))
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:DescribeKey'],
      resources: [props.secretsKey.keyArn],
      conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com` } },
    }))
    fn.addToRolePolicy(props.mail.sesSendPolicy)

    // Its own retention: a nested stack's functions are invisible to the
    // parent's sweep (issue 135), and the privacy policy promises a year.
    new logs.LogRetention(this, 'AuthFnLogs', {
      logGroupName: `/aws/lambda/${fn.functionName}`,
      retention: logs.RetentionDays.ONE_YEAR,
    })

    /*
     * A sign-in code that does not go out is a page, not a log line.
     *
     * Better Auth answers `success: true` to the code request even when the
     * send threw - it runs the send in a wrapper that swallows the error.
     * The only signal left is the `sign-in code not sent` line otp-mail.ts
     * writes, so that line becomes a metric and one occurrence in five
     * minutes raises the alarm. Absolute count, not a rate: at this volume
     * one failed code is already every code.
     */
    const codeNotSent = new logs.MetricFilter(this, 'CodeNotSentFilter', {
      logGroup: fn.logGroup,
      metricNamespace: 'MakerBay/Auth',
      metricName: 'SignInCodeNotSent',
      filterPattern: logs.FilterPattern.literal('"sign-in code not sent"'),
      metricValue: '1',
    })
    const codeNotSentAlarm = new cloudwatch.Alarm(this, 'CodeNotSentAlarm', {
      alarmName: 'makerbay-auth-code-not-sent',
      alarmDescription: 'A sign-in code failed to send. Check the auth function logs and the mail provider key.',
      metric: codeNotSent.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    codeNotSentAlarm.addAlarmAction(new cloudwatchActions.SnsAction(props.alerts))

    // No authorizer on any of these: they ARE the authorizer's issuer.
    // Explicit methods, never ANY, so the CORS preflight is answered by the
    // API and not by the function (the parent's rule).
    const integration = new HttpLambdaIntegration('AuthIntegration', fn)
    // /auth-bridge is gone (issue 158 part B): with cookies first-party on
    // the dashboard origin, the redirect back from an upstream sign-in lands
    // on the dashboard already holding a session.
    for (const [name, routePath, method] of [
      ['AuthGet', '/auth/{proxy+}', apigwv2.HttpMethod.GET],
      ['AuthPost', '/auth/{proxy+}', apigwv2.HttpMethod.POST],
    ] as const) {
      new apigwv2.HttpRoute(this, name, {
        httpApi: props.httpApi,
        routeKey: apigwv2.HttpRouteKey.with(routePath, method),
        integration,
      })
    }

    this.handler = fn
    this.table = table
    this.secret = secret
    new cdk.CfnOutput(this, 'AuthTableName', { value: table.tableName })
    new cdk.CfnOutput(this, 'AuthJwksUrl', { value: `${apiUrl}/auth/jwks` })
  }
}
