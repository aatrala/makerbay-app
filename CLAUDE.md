# MakerBay — Project Guidance

## Project facts

- AWS account `953146692138`, CLI profile `makerbay`, region `us-east-1`.
- Domain `makerbay.app` (Route 53). Subdomains: `app.` dashboard, `api.` API,
  `chat.` hosted chat, `widget.` embed script, `mcp.` MCP server,
  `admin.` staff console, `admin-api.`, `help.` public help centres,
  `stream.` streaming chat.
- $80/month AWS Budget `monthly-cost-80-usd` with email alerts is live — check
  Cost Explorer after infra changes.
- Monorepo: npm workspaces. `infra/` (CDK), `packages/core/`, `modules/<name>/`,
  `web/`. One CDK stack (`Makerbay`) until stage triggers say otherwise.
- Every DynamoDB item is tenant-scoped. Data access goes through
  `packages/core` — never hand-roll table access in module code.
- Usage metering events on EventBridge bus `makerbay` are a stable contract:
  `{ tenantId, moduleId, metric, quantity, idempotencyKey, ts }`.
- `planning/SPEC.md` is the source of truth for milestones and acceptance
  criteria, and its section 8 holds founder-only items with long lead times.
  Those are mirrored as issues in `planning/todo.md`; keep the two in step.
  `modules/*/module.json` is the source of truth for the modules themselves -
  it generates the marketing pages, the roadmap and the version endpoint.
- Run `npm run typecheck` before any deploy. CDK bundles Lambda code with
  esbuild, which does NOT typecheck, so without it a type error ships silently.
  It runs two projects: `typecheck:api` (Lambdas and packages) and
  `typecheck:ui` (the dashboard, the admin console and every module's screens).
  Until 2026-08-28 it ran only the first, so a syntax error in a module UI
  passed a green typecheck and failed at build time.
- **`cdk deploy` does NOT publish the customer-facing pages.** There is no
  BucketDeployment in the stack, so `modules/assistant/embed/src/*` (chat.css,
  pages.js, chat.js, widget.js, index.html) stays as-is however many times you
  deploy. After changing any of them run
  `node scripts/publish-embed.mjs`, which uploads what actually differs, sets
  cache-control and invalidates. `--check` reports drift and exits non-zero.
  This bit issue 118 phase 2: the server-rendered shell shipped correct while
  the script it loads was two days stale.
- **Lambda log retention is NOT in CDK, and cannot be.** The privacy policy
  promises logs are kept 12 months, so every `/aws/lambda/Makerbay-*` group
  is set to 365 days. It is applied with `aws logs put-retention-policy`
  rather than the `logRetention` prop because that prop adds one
  `Custom::LogRetention` resource per function: 32 functions against 492 of a
  hard 500 would put the stack at 524 and fail to deploy. **After adding a new
  Lambda, set retention on its log group** or the policy becomes untrue again:
  `aws logs put-retention-policy --log-group-name /aws/lambda/<name>
  --retention-in-days 365 --profile makerbay`. Note Git Bash mangles the
  leading slash - prefix the command with `MSYS_NO_PATHCONV=1`. The proper
  fix is a nested stack holding the retention resources (issue 135).
- Contacts is core: always on, `entitlementKey: null`. Other modules attach
  customers with `upsertContact` and `appendContactEvent` from `packages/core`
  rather than keeping their own list.

## AWS Guidance

- Prefer the AWS MCP Server for AWS interactions — it provides sandboxed
  execution, observability, and audit logging. If unavailable, use the
  AWS CLI directly.
- Before starting a task, check whether a relevant AWS skill is available.
  Load the skill with `retrieve_skill` and prefer its guidance over
  general knowledge.
- When uncertain about specific AWS details (API parameters, permissions,
  limits, error codes), verify against documentation rather than guessing.
  State uncertainty explicitly if you cannot confirm.
- When creating infrastructure, prefer infrastructure-as-code (AWS CDK or
  CloudFormation) over direct CLI commands.
- When working with infrastructure, follow AWS Well-Architected Framework
  principles.
- Do not use em dashes in AWS resource names or descriptions. Use
  hyphens instead.

## Secret Safety

- MUST load the `aws-secrets-manager` skill first for any secret,
  credential, API key, token, or password task. MUST NOT call
  `secretsmanager get-secret-value` or `batch-get-secret-value`, and MUST
  NOT hit the Secrets Manager Agent daemon directly. MUST use
  `{{resolve:secretsmanager:secret-id:SecretString:json-key}}` with
  `asm-exec` so the secret resolves at runtime without entering context.
