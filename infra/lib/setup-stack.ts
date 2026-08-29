import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as events from 'aws-cdk-lib/aws-events'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import type { Construct } from 'constructs'

/**
 * "Set it up for me" (docs/spec-concierge.md), in its own nested stack.
 *
 * The reason it is nested rather than part of the main stack: CloudFormation
 * caps a stack at 500 resources, and the main stack reached 509 the day this
 * module first tried to deploy (issue 111). A nested stack costs the parent
 * ONE resource and carries its own 500-resource budget, so this module and
 * everything phase 3 adds - the job state machine, the payment plumbing -
 * grow without touching the parent's ceiling again.
 *
 * **Why only this module moved.** Every table in the main stack has an
 * explicit `tableName` AND `RemovalPolicy.RETAIN`, so moving one to another
 * stack orphans it under its name and the new stack then cannot create a
 * table whose name is taken. Moving a live table needs CloudFormation
 * resource import, one seam at a time, verified per table. This module was
 * the one place that migration was free: its table was created the same day
 * and held nothing, so it could simply be renamed.
 *
 * New modules should start here rather than in the parent.
 */

export interface SetupStackProps extends cdk.NestedStackProps {
  repoRoot: string
  domain: string
  bus: events.IEventBus
  /** Read-only, purely to diff against. Every write leaves over the module API. */
  readTables: {
    presenceConfig: dynamodb.ITable
    bookingServices: dynamodb.ITable
    assistantConfig: dynamodb.ITable
    sources: dynamodb.ITable
    quotesConfig: dynamodb.ITable
  }
  /** Tenancy, entitlements and usage, shared with every other module. */
  coreTableEnv: Record<string, string>
  coreTables: dynamodb.ITable[]
}

export class SetupStack extends cdk.NestedStack {
  /** The parent attaches the API route to this. */
  public readonly handler: lambda.IFunction
  /**
   * The jobs table, exposed so the parent can grant read access.
   *
   * Presence renders the pre-signup page preview and therefore needs the
   * prospect draft that lives here (issue 145). The read itself goes through
   * packages/core, which is where cross-module data access belongs; this only
   * exposes the table so the grant can be written.
   */
  public readonly jobs: dynamodb.ITable

  constructor(scope: Construct, id: string, props: SetupStackProps) {
    super(scope, id, props)

    // Renamed from makerbay-setupjobs on the move. The old table was created
    // the same day, held nothing, and a fresh name avoids the collision that
    // an orphaned RETAIN table would otherwise cause. Delete the orphan once
    // this is live.
    const jobs = new dynamodb.Table(this, 'Jobs', {
      tableName: 'makerbay-setup-jobs',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    const fn = new NodejsFunction(this, 'ApiFn', {
      entry: path.join(props.repoRoot, 'modules/setup/api/src/handler.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // A site walk fetches many pages before it proposes anything.
      memorySize: 1024,
      timeout: cdk.Duration.seconds(120),
      depsLockFilePath: path.join(props.repoRoot, 'package-lock.json'),
      environment: {
        ...props.coreTableEnv,
        TABLE_SETUPJOBS: jobs.tableName,
        TABLE_PRESENCECONFIG: props.readTables.presenceConfig.tableName,
        TABLE_BOOKINGSERVICES: props.readTables.bookingServices.tableName,
        TABLE_ASSISTANT_CONFIG: props.readTables.assistantConfig.tableName,
        TABLE_SOURCES: props.readTables.sources.tableName,
        TABLE_QUOTESCONFIG: props.readTables.quotesConfig.tableName,
        API_BASE: `https://api.${props.domain}`,
      },
    })

    jobs.grantReadWriteData(fn)
    for (const t of Object.values(props.readTables)) t.grantReadData(fn)
    for (const t of props.coreTables) t.grantReadData(fn)
    props.bus.grantPutEventsTo(fn)
    fn.addToRolePolicy(new iam.PolicyStatement({
      // Extraction only. The model that reads a scraped page is invoked with
      // no tools at all, so this grant cannot reach anything but text.
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }))

    this.jobs = jobs
    this.handler = fn
    new cdk.CfnOutput(this, 'SetupJobsTable', { value: jobs.tableName })
  }
}
