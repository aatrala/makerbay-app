# @makerbay/core

Shared platform code used by every module Lambda:

- **Auth**: resolve Cognito JWTs and API keys (`mb_sk_` secret / `mb_pk_` publishable) to a tenant context.
- **Tenancy guard**: the only sanctioned DynamoDB access layer — every query is tenant-scoped by construction.
- **Entitlements**: module enablement + plan limit checks.
- **Metering**: emit usage events to the `makerbay` EventBridge bus.

Module code MUST go through this package for data access. See SPEC.md §3.
