# NestJS module boundaries

`HealthModule`, `IdentityModule` and the infrastructure-only `AccessModule` are registered in `AppModule`. Identity currently implements first-party email/password registration and sessions, OTP challenge APIs and MFA APIs. Access reuses the session service and REN2-26 `access.effective_permissions` view, but registers no controller and exposes no brand business endpoint.

Catalog, cart, checkout, orders, payments, fulfillment, settlements and integrations are still scaffolding modules. Do not treat their placeholders or proposed database models as implemented capabilities. Add a real module's handlers, application services, domain entities, repository interfaces, tests, API contract and Postman examples before registering its routes.

## Brand-owned repository access

Future brand-owned handlers must use `@UseGuards(BrandAccessGuard)` and `@RequireBrandPermission('<resource>.<action>')`, then pass the resulting `request.brandAccess` context to every repository query. Every resource alias in a read, detail, list, search, count, nested, export, bulk update or delete query must include `buildBrandScopePredicate(alias, context)` and its bound parameters. Apply the predicate to both parent and child aliases in nested queries. Never build SQL by concatenating request values or accept a client-supplied user, role, or permission as authority.

The predicate checks `access.effective_permissions` in the same SQL statement. Keep permission resolution uncached and run protected operations as short autocommit/READ COMMITTED units. A committed revocation is visible to the next statement using a fresh READ COMMITTED snapshot; an already-running statement or older transaction snapshot cannot be cancelled retroactively. The existing permission view evaluates time windows with PostgreSQL `CURRENT_TIMESTAMP`, so expiry is relative to transaction start. A detail query with no scoped row should use the endpoint's reviewed non-disclosing not-found policy. Cookie-authenticated mutations still require their separately reviewed CSRF and, where applicable, MFA guards.

Global taxonomy administration uses `@RequireGlobalTaxonomyPermission('taxonomy.manage' | 'taxonomy.approve')`. It composes `PlatformPermissionGuard` with `MfaGuard`: the permission must be globally effective from the W1 session, and persisted MFA freshness must be within five minutes. The permission codes are not granted or seeded by this decorator; approved global grants remain an owner-controlled prerequisite. Cookie-authenticated mutations also require the existing CSRF policy.

REN2-27 tests these rules against temporary synthetic tables in the disposable PostgreSQL 16 CI database; no permanent business resource table or endpoint is introduced.

## Existing business boundaries

- A brand owns its own products and SKUs.
- PostgreSQL is authoritative for inventory, checkout, orders, outbox/inbox and ledger.
- Redis is ephemeral and Typesense search is a projection.
- Payment providers collect from customers; seller bank transfers are manual external actions, never scheduled or called through provider payout APIs.
- Owner decisions tracked in the Engineering OS must be approved before production logic and acceptance tests.
