# REN2-27 Server-Resolved Brand Access Design

## Intent

Enforce brand permissions from Renivet's authenticated opaque session and PostgreSQL access model. A selected or submitted brand ID is only a requested scope; it is never proof of access. Future brand-owned repositories must include a database predicate that limits every result and mutation to that verified brand and rechecks the current permission in the same SQL statement.

## Sources and scope

- Linear REN2-27: “W1-B2 — Enforce server-resolved membership and brand-scoped repository queries”, including AC-01..04 and T-AZ-01..03, T-AZ-06..08, T-DB-05.
- REN2-26 adds `access.effective_permissions`; it resolves active users, current role windows, active joined memberships, and approved brands.
- REN2-23 provides the opaque `__Host-renivet_session` cookie and `SessionService.authenticate`.
- There are no brand resource tables or brand business endpoints yet. This task must not invent product/order/payment APIs or real domain resources.

## Proposed implementation decisions

- **Authentication:** reuse `SessionService`; the guard derives the actor only from the single well-formed first-party session cookie. Ignore request body, query and caller-supplied identity/role claims.
- **Permission:** a route declares a stable permission code through `@RequireBrandPermission`. A Nest guard reads a UUID `brandId` path parameter and queries `access.effective_permissions` for that server-authenticated user and permission. A matching global permission or a matching brand-scoped permission can grant the requested brand. Missing metadata, malformed/missing brand ID, no permission or stale membership denies access. Repository/service errors fail closed as 503.
- **Tenant predicate:** expose one reusable SQL predicate builder requiring the opaque context created only after the guard succeeds. It binds the selected `brand_id`, user ID and required permission as parameters, and includes an `EXISTS` check against `access.effective_permissions` in the resource SQL itself. This rechecks revocation and expiry at query time, so a previously authorized request context cannot keep reading after its grant becomes ineffective.
- **Query-shape evidence:** use a temporary synthetic resource table in disposable PostgreSQL integration tests, not a permanent schema table or public fixture endpoint. Exercise detail, list, search, count, nested, bulk update and export SQL through the shared predicate. Prove Brand A cannot see/count/change/export Brand B fixtures; a multi-brand actor succeeds only in each currently authorized brand.
- **Denial behavior:** no brand permission returns a generic 403 independent of resource existence. A scoped detail query with no visible row returns no row so a future HTTP handler can map it to the reviewed non-disclosing not-found response. No public resource route is introduced in this task.
- **Freshness:** do not cache permissions. Each guard check queries PostgreSQL, and each scoped resource statement independently rechecks effective permissions. Under the normal short, autocommit/READ COMMITTED operation, a committed grant revocation is visible to the next statement. PostgreSQL transactions already holding an older snapshot can continue to observe that snapshot until they end; no in-flight query or old snapshot is retroactively cancelled. The existing view uses `CURRENT_TIMESTAMP`, so time-based expiry is evaluated relative to transaction start.
- **CSRF/MFA:** existing cookie-authenticated mutation CSRF policy and `MfaGuard` remain separate controls for future mutations; this task does not add new API endpoints or apply privileged-MFA rules beyond current route metadata.
- **Contracts:** no new HTTP endpoint means no OpenAPI/Postman operation change. Existing OpenAPI/Postman drift checks must remain green.

## Approaches considered

1. **Guard only:** rejected. It cannot stop an unscoped detail, count, bulk or export query and leaves a race between authorization and SQL.
2. **PostgreSQL row-level security on all future tables:** rejected for this slice because no brand-owned resource tables exist yet and connection-local identity plumbing is not established. RLS may be considered by the resource-owning feature when real tables exist.
3. **Session-backed guard plus same-statement SQL scope predicate:** selected. It blocks unauthorized requests early while the DB predicate remains the data boundary and rechecks current effective permissions for every query shape.

## Goals

- Default deny for absent identity, invalid permission metadata, invalid brand IDs, absent permission and database failure.
- Never trust caller-supplied user ID, role, or brand as authority.
- Prove scoped read/write behavior for the requested fixture query shapes using live PostgreSQL.
- Keep cross-brand read, count, nested, bulk and export results indistinguishable from absent data at the repository/query layer.
- Avoid permission caches so committed revocations are seen by the next query.

## Non-goals

- Creating product, order, inventory, payment, seller, staff, or admin resource endpoints.
- Designing UI, changing role permissions, adding RLS to nonexistent business tables, or claiming business features already exist.
- Changing OpenAPI or Postman for nonexistent endpoints.
- Running migrations against anything except the disposable local/CI PostgreSQL service; this task should require no migration.

## Acceptance mapping

- AC-01: synthetic Brand A/B plus multi-brand fixture exercises detail, nested, list, search, count, bulk update and export.
- AC-02: guard context is issued only for current effective permissions; every scoped query rechecks the same view. No cache.
- AC-03: deny/revocation tests cover a previously issued scope context after grant/membership state changes.
- AC-04: CI runs focused SQL/guard integration tests on disposable PostgreSQL. Any real endpoint would require OpenAPI/Postman, but none is created here.

## Remaining implementation choices

- Keep the guard and SQL-scope helper in a focused access module and export the guard for future handlers without registering fake controllers.
- Reuse the current PostgreSQL pool from `IdentityInfrastructure`; if unavailable, reject access.
- Share one cookie parser with the existing auth/MFA code to avoid policy drift.
