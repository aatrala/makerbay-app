import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as events from 'aws-cdk-lib/aws-events'
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as sns from 'aws-cdk-lib/aws-sns'
import { Construct } from 'constructs'

/**
 * Monitoring that asks whether the product works, rather than what it costs
 * (issue 145).
 *
 * The existing alarms in the main stack all watch spend or deliverability -
 * Bedrock invocations, API request volume, SES bounces and complaints. Not one
 * of them watches whether a customer can do anything. So when signup broke on
 * 27 August, it stayed broken for three days and was found by a code review.
 *
 * **Why a nested stack.** The parent is at 492 of CloudFormation's hard 500,
 * and this costs six resources. A NestedStack costs the parent ONE and brings
 * its own budget - the pattern issue 111 established for the setup module.
 * Monitoring is also the right shape for it: it shares nothing with the
 * application beyond a user pool id and an SNS topic, so nothing here has to
 * be untangled later.
 */
export interface MonitoringStackProps extends cdk.NestedStackProps {
  repoRoot: string
  userPoolId: string
  userPoolClientId: string
  userPoolArn: string
  /** Where an alarm goes. The same topic the abuse alarms already use. */
  alerts: sns.ITopic
}

export class MonitoringStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props)

    /*
     * Signs up for real, every fifteen minutes.
     *
     * The address is deliberately at example.com rather than a domain we own.
     * A canary signing up as canary@makerbay.app would have passed happily
     * throughout the outage, because that domain was a verified SES identity
     * and the bug only affected everybody else. The canary has to look like a
     * stranger or it tests nothing. IANA reserves example.com and it accepts
     * no mail, so no message can reach a real person however the sender is
     * configured.
     */
    const canary = new NodejsFunction(this, 'SignupCanaryFn', {
      entry: path.join(props.repoRoot, 'packages/core-api/src/signup-canary.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      depsLockFilePath: path.join(props.repoRoot, 'package-lock.json'),
      environment: {
        USER_POOL_ID: props.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClientId,
      },
    })
    canary.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:SignUp', 'cognito-idp:AdminDeleteUser'],
        resources: [props.userPoolArn],
      }),
    )
    // No PutMetricData permission needed: the canary emits its metric in
    // CloudWatch's embedded format, so the log line IS the metric.

    new events.Rule(this, 'SignupCanarySchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new eventsTargets.LambdaFunction(canary)],
    })

    const broken = new cloudwatch.Alarm(this, 'SignupBroken', {
      alarmName: 'makerbay-signup-broken',
      alarmDescription:
        'Nobody can create an account. The canary signed up and was either refused or given no '
        + 'code. Check the user pool sender first: that is exactly how issue 137 presented, and '
        + 'it went unnoticed for three days.',
      metric: new cloudwatch.Metric({
        namespace: 'MakerBay/Canary',
        metricName: 'SignupWorks',
        statistic: 'Minimum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      // Two in a row: one transient Cognito error should not wake anybody, but
      // a real outage is caught within half an hour rather than in days.
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      // No data means the canary itself stopped, which is also worth knowing.
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    })
    broken.addAlarmAction(new actions.SnsAction(props.alerts))
  }
}
