# MakerBay

Modular B2B SaaS platform for SMBs. Businesses subscribe to a base plan and
enable capability **modules** as plugins — AI assistant, booking, dashboards,
messaging bots, compliance. Every module is API-first: dashboard, REST API with
tenant API keys, and (later) MCP.

**Domain:** [makerbay.app](https://makerbay.app) · **Spec:** [SPEC.md](SPEC.md)

## Repository layout

```
infra/               CDK app (TypeScript) — all AWS infrastructure, one stack
packages/core/       Shared platform code: auth, tenancy guard, entitlements, metering
modules/
  assistant/         Module 1 — RAG chatbot (api/ Lambda code, web/ dashboard UI)
web/                 Dashboard shell (React + Vite) at app.makerbay.app
```

## Stack

- API Gateway HTTP API + Lambda (Node.js 22, arm64) · DynamoDB (on-demand) ·
  EventBridge · Cognito · S3 + CloudFront · Amazon Bedrock (Knowledge Bases + Claude)
- Region `us-east-1`, single CDK stack, deployed via `cdk deploy` (CI on `main` later)

## Development

```
npm install
npm -w infra run deploy    # requires AWS profile "makerbay"
```

See [SPEC.md](SPEC.md) for milestones (M0–M4) and acceptance criteria.

## License

Apache-2.0 — see [LICENSE](LICENSE).
