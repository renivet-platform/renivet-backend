# Authentication and authorization guards

Role/tenancy enforcement must be server-side and deny by default. No placeholder guard is registered or assumed effective.

REN2-24 provides `@RequireMfa(action)` and `MfaGuard` for sensitive handlers. The guard ignores caller-supplied role/MFA claims, authenticates the opaque session through `SessionService`, applies persisted MFA freshness within 300 seconds in enforced mode, and audits both allow and denial decisions. Missing authentication returns 401; missing/stale elevation returns 403 in enforced mode. A sensitive route opts in with the action metadata and guard. Current call sites and actions are listed in `docs/security/ren2-116-mfa-enforcement-deferral.md`; reusable actions without a current route are not evidence that those operations already exist. Apply normal permission, tenant-scope and mutation CSRF controls independently.
# Brand access guard

`BrandAccessGuard` is exported by `AccessModule` for future brand-owned routes. A handler must use `@UseGuards(BrandAccessGuard)` and declare a stable permission with `@RequireBrandPermission('resource.action')`. The guard accepts identity only from one valid `__Host-renivet_session` cookie, authenticates it through `SessionService`, validates the route's `brandId`, and resolves either an exact brand grant or an applicable global grant through `access.effective_permissions`. It does not trust request body, query, or ad hoc `request.user` claims.

The guard is an early request check, not the data boundary. Repositories must use `buildBrandScopePredicate` in the same SQL statement for every protected resource alias so permissions are rechecked at query time. Permissions are deliberately not cached. Use short autocommit/READ COMMITTED operations: fresh statements see committed revocations, while in-flight statements and older transaction snapshots cannot be cancelled retroactively. The underlying view evaluates time windows using transaction-start `CURRENT_TIMESTAMP`. Keep CSRF and privileged MFA checks separate and apply them to the relevant mutation handlers.

There are no brand business routes in this slice. The guard and query contract are exercised by unit tests and disposable PostgreSQL fixtures rather than example production endpoints.

# Platform-global permission guard

`PlatformPermissionGuard` is exported by `AccessModule` for operations with no brand scope, such as platform taxonomy administration. Declare the exact permission with `@RequirePlatformPermission('taxonomy.manage')` and apply the guard to the route. It derives the actor from the same opaque W1 session but accepts only an `access.effective_permissions` row with `scope_type = 'global'` and `brand_id IS NULL`; a brand-scoped grant, path/body/query claim, or client role cannot authorize it. The guard fails closed on missing policy and repository/session failures.

W1 currently seeds no taxonomy permission, so a taxonomy route remains denied until an approved permission grant is added. This guard does not replace CSRF, MFA, audit, or mutation transaction controls, and does not imply that W2 taxonomy routes exist.

REN2-116 adds a server-owned enforcement mode: `MFA_ENFORCEMENT_MODE` defaults to `enforced`; `deferred` is valid only in `development` and `test`. The guard still authenticates the session and audits every decision. Deferral skips only recent MFA freshness; authorization, tenant scope, CSRF, idempotency, maker-checker and state checks remain independently required. Staging/production reject deferral. Route metadata is retained and documents the conditional policy in OpenAPI. See `docs/security/ren2-116-mfa-enforcement-deferral.md` for the call-site inventory and evidence status.
