import * as cdk from 'aws-cdk-lib'
import * as logs from 'aws-cdk-lib/aws-logs'
import { Construct } from 'constructs'

/**
 * Log retention, in infrastructure rather than in a runbook (issue 135).
 *
 * The privacy policy promises application logs are kept twelve months and
 * then deleted. Until now that was true only because it had been applied by
 * hand with `aws logs put-retention-policy`, and CLAUDE.md carried a note
 * telling whoever added the next Lambda to remember. A published commitment
 * that depends on somebody remembering is not a commitment.
 *
 * **Why it could not go in the main stack.** CDK's `logRetention` prop adds
 * one `Custom::LogRetention` resource per function. Thirty-odd functions
 * against 493 of a hard 500 would have failed to deploy - which is exactly
 * why it was done by hand in the first place.
 *
 * A NestedStack costs the parent ONE resource and brings its own 500-resource
 * budget, the same escape hatch issue 111 established for the setup module.
 *
 * **Why LogGroup.fromLogGroupName and not the function's own log group.**
 * Declaring `new logs.LogGroup(...)` for a function CDK already creates would
 * collide on deploy: the group exists, made by Lambda on first invocation,
 * and CloudFormation refuses to create it again. Importing by name and
 * applying retention through a small custom resource is the only route that
 * works on groups that already have data in them.
 */
export interface LogRetentionStackProps extends cdk.NestedStackProps {
  /** Every Lambda whose logs this governs, by function name. */
  functionNames: string[]
  retention?: logs.RetentionDays
}

export class LogRetentionStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: LogRetentionStackProps) {
    super(scope, id, props)

    const retention = props.retention ?? logs.RetentionDays.ONE_YEAR

    for (const [i, name] of props.functionNames.entries()) {
      /*
       * `logGroupName` is the physical name Lambda uses. The construct id is
       * the index rather than the name because function names contain
       * characters CloudFormation logical ids reject, and because a rename
       * upstream should not silently orphan the retention resource.
       */
      new logs.LogRetention(this, `Retain${i}`, {
        logGroupName: `/aws/lambda/${name}`,
        retention,
      })
    }
  }
}
