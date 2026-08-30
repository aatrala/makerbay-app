# Stack split plan (issue 153)

Status: **written 2026-08-30, awaiting founder approval of the approach.**
Nothing here is executed yet. The CI guard (issue 152,
`scripts/check-stack-budget.mjs`) is live and prints the count on every push:
warn at 480, fail at 498.

## The problem, precisely

The `Makerbay` stack holds **496 of CloudFormation's hard 500** resources.
The ceiling is per stack template; nested stacks carry their own 500 budget
and cost the parent one resource each - which is why log retention, setup and
monitoring already live in nested stacks. At 500, `cdk deploy` refuses, and
whatever feature forced the 500th resource becomes an incident instead of a
line in a diff.

Where the 496 actually goes (synth of 2026-08-30):

| Count | Type | Share |
|---|---|---|
| 118 | Lambda::Permission | the API surface: |
| 102 | ApiGatewayV2::Route | **253 resources, 51%** |
| 33 | ApiGatewayV2::Integration | |
| 38 | DynamoDB::Table | compute + data: |
| 34 | IAM::Role | **136 resources, 27%** |
| 32 | IAM::Policy + 32 Lambda::Function | |
| ~60 | CloudFront (7 distributions, 5 functions, 4 OACs, 3 cache policies), S3 (6+6), Route 53 (24), domain names/mappings | the edge surface, 12% |
| rest | Events rules, alarms, SES identities, nested-stack anchors | |

The headline: **half the stack is API plumbing, and a third of THAT is
redundant.** 118 Lambda permissions exist for 33 integrations because CDK's
`HttpLambdaIntegration` mints one route-scoped permission per route - so a
function serving eight routes carries eight near-identical permissions.

## The plan, in order

### Step 0 - the guard (DONE, issue 152)

`check-stack-budget.mjs` runs in CI after synth. The count can never again
approach the wall silently; this document is what the WARN points at.

### Step 1 - squash Lambda permissions (~85 resources back, one deploy)

Replace CDK's per-route permissions with **one permission per function**,
scoped `SourceArn: <this API's ARN>/*/*` - via a small CDK Aspect that visits
`CfnPermission` nodes belonging to HTTP-API integrations, drops the
route-scoped ones, and adds a single wildcard-on-route permission per
function.

- **Frees:** ~85 resources (118 → ~33). 496 → ~411, comfortably under WARN.
- **Security is unchanged in substance:** the wildcard is still scoped to
  OUR API's ARN - the same trust boundary, since the API's own route table
  already decides what reaches each function. No cross-account or
  cross-API surface is added.
- **Risk: low.** Permissions are stateless; CloudFormation creates the new
  one before deleting the old within the same update, so there is no window
  where the API cannot invoke. Rollback is `git revert` + deploy.
- **Verify:** `cdk diff` shows only `AWS::Lambda::Permission` changes;
  after deploy, one scripted pass calls every public route (the existing
  verify scripts cover quotes/share; a smoke list covers the rest).

### Step 2 - standing policy: new features land in purpose-scoped nested stacks

Already the de-facto pattern (LogRetention, Setup, Monitoring). Written down
as policy: **a new feature that brings more than ~5 resources gets its own
nested stack** unless it must share the HTTP API. Costs the parent 1 each.
The one thing that cannot move this way is API routes - they must live where
the `HttpApi` lives - which is exactly why Step 1 targets the API surface's
waste instead.

### Step 3 - edge split (only if Steps 1-2 prove insufficient)

Move the static/CDN surface (~60 resources: site + dashboard + chat + doc
hosts - distributions, buckets, OACs, cache policies, Route 53 records) to a
`MakerbayEdge` stack using **CloudFormation stack refactor**
(`aws cloudformation create-stack-refactor`), which moves resources between
stacks without replacement - so no bucket is emptied and no distribution is
recreated (a distribution replacement would mean hours of DNS/cert
migration and cache loss).

- **Seams are clean:** the buckets have deterministic names the publish
  scripts already use (`makerbay-site-${account}`); distributions reference
  the API by domain name, not by ref. Two values cross the boundary
  (distribution IDs used in invalidation docs) - both are already treated
  as strings.
- **Move order:** site first (lowest blast radius, easiest verify), then
  web, then chat/doc hosts.
- **Risk: medium** - refactor mappings must be exact, and a mistake at this
  layer is customer-visible. Hence: only when the count demands it, never
  preemptively.

### Explicitly rejected

- **Splitting the HTTP API into two APIs** (routes are the biggest block,
  but two APIs means two domains or path-based routing gymnastics, CORS
  duplication, and a permanent tax on every new module).
- **Single-table DynamoDB migration** to reduce the 38 tables (a data
  migration with tenant-facing risk, to save resources Step 1 saves for
  free).
- **Moving Lambdas out of the main stack** (they must sit beside the API
  routes that invoke them, or every deploy crosses a stack boundary).

## What approval means

Approving this plan approves **Step 1 now** (one Aspect, one deploy, verify
pass) and **Step 2 as policy**. Step 3 stays parked until the guard's WARN
returns after Step 1 - which at the current growth rate (~30 resources per
quarter, dominated by routes at 2-3 per feature) is roughly a year away.
