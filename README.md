# MakerBay

Modular B2B SaaS for small businesses. A workspace subscribes to a base plan and
switches on capability **modules** one at a time. Every module is API-first: a
dashboard screen, a REST API with tenant-scoped keys, and an MCP surface so
agent tools can use it too.

**Live:** [makerbay.app](https://makerbay.app) · **App:** [app.makerbay.app](https://app.makerbay.app) ·
**Roadmap:** [makerbay.app/roadmap](https://makerbay.app/roadmap) ·
**Changelog:** [CHANGELOG.md](CHANGELOG.md)

## Repository layout

```
infra/                CDK app (TypeScript) - all AWS infrastructure, one stack
packages/
  core/               Shared platform code: tenancy, entitlements, metering, manifests
  core-api/           Platform API: workspaces, keys, usage, billing
  admin-api/          Staff-only API: grants, audit (separate Cognito pool, MFA required)
  mcp-server/         Hosted MCP endpoint at mcp.makerbay.app
  web-kit/            Everything a module's screens may import: API client,
                      shared components, the stylesheet
modules/
  <module>/
    module.json       The single description of a module - see below
    api/              Lambda handlers for /v1/<module>/*
    web/              Dashboard screens, exported as one DashboardModule
    embed/            Customer-facing script, where the module has one
web/                  Customer dashboard (React + Vite) at app.makerbay.app
admin/                Staff console at admin.makerbay.app - separate Cognito
                      pool, MFA required, no self-signup
site/                 Marketing site at makerbay.app - partly generated, see below
docs/                 Design guidelines, specs, research
```

## The module manifest

`modules/<id>/module.json` is the only place a module is described. It feeds:

- the version endpoint and the dashboard footer,
- the marketing page at `makerbay.app/modules/<id>`,
- the homepage module grid and the public roadmap,
- which metrics the module is allowed to meter.

Anything about a module that appears in two places is a bug. Add the field to
the manifest and read it from `packages/core/src/version.ts`.

A module with `"core": true` (currently only Contacts) ships with every
workspace and has `entitlementKey: null` - there is nothing to switch on. Use
this only for substrate that other modules depend on, because a module cannot
depend on something that might be switched off.

## Adding a module

1. `modules/<id>/module.json` with the manifest, including its `marketing`
   block and its place in `roadmap.order`.
2. Register it in `packages/core/src/version.ts`.
3. `modules/<id>/api/` for the Lambda, routed under `/v1/<id>/*` with
   **explicit HTTP methods** - never `ANY`, which swallows the CORS preflight
   and breaks the browser client.
4. `modules/<id>/web/` exporting one `DashboardModule` (nav plus routes),
   built on [docs/design-guidelines.md](docs/design-guidelines.md) and
   `@makerbay/web-kit`. Register it in `web/src/modules.ts`.
5. A `CHANGELOG.md` entry tagged with the module id.

A module must import only from `@makerbay/web-kit`. Reaching into the shell or
another module couples them together and is what the layering exists to stop.

Data access goes through `packages/core`. Never hand-roll a DynamoDB call in
module code - the tenancy guard lives in one place on purpose.

## Versioning

- `PLATFORM_VERSION` in `packages/core/src/version.ts` covers the core:
  tenancy, auth, entitlements, billing.
- Each module carries its own `version` map per surface (`api`, `web`,
  `embed`), so a widget fix does not imply an API change.
- Both are semantic versions. A breaking API change means a new `/v2/` route,
  not a silent change under `/v1/`.

## Stack

API Gateway HTTP API + Lambda (Node 22, arm64) · DynamoDB on-demand ·
EventBridge · Cognito · S3 + CloudFront · Bedrock Knowledge Bases with S3
Vectors · Stripe Billing with metered usage. Region `us-east-1`, one CDK stack.

Two deliberate cost choices worth knowing before you change them: the knowledge
base uses **S3 Vectors**, not OpenSearch Serverless, which would cost roughly
$700/month at zero traffic; and streaming runs on a **Lambda Function URL**
behind CloudFront, because API Gateway cannot stream a response.

## Development

```bash
npm install
```

```bash
npm -w infra run deploy
```

```bash
npm -w web run build && npm -w admin run build && npm -w site run build
```

Deploys need the AWS profile `makerbay`. Publishing the built output:

```bash
aws s3 sync web/dist s3://makerbay-web-953146692138/ --delete --profile makerbay
```

```bash
aws s3 sync site/dist s3://makerbay-site-953146692138/ --delete --profile makerbay
```

```bash
aws s3 sync admin/dist s3://makerbay-admin-953146692138/ --delete --profile makerbay
```

Then invalidate the matching distribution: `E20XQRRSODE0FA` for the app,
`ED2PETE8C9RT1` for the site, `EX8L5GXSR64D0` for the staff console.

Note for Windows: pass JSON to the AWS CLI from a file (`file://payload.json`)
rather than inline. PowerShell strips the double quotes out of an inline JSON
argument before the CLI ever sees it.

## Secrets

Never read a secret into a shell or a log. Stripe keys live in the
`makerbay/stripe` secret in Secrets Manager and are resolved at runtime with
`{{resolve:secretsmanager:...}}`. See the `aws-secrets-manager` skill and
[CLAUDE.md](CLAUDE.md).

## Release checklist

1. `npm -w web run build`, `npm -w admin run build` and `npm -w site run build`
   all pass.
2. Bump `PLATFORM_VERSION` and/or the module's `version` map.
3. Add the `CHANGELOG.md` entry, tagged `platform` or the module id.
4. Deploy infra if it changed, then publish web and site and invalidate.
5. Check the changed screens at 1280px and 375px.

## License

Apache-2.0 - see [LICENSE](LICENSE).
