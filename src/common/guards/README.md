# Authentication and authorization guards

Role/tenancy enforcement must be server-side and deny by default. No placeholder guard is registered or assumed effective.

REN2-24 provides `@RequireMfa(action)` and `MfaGuard` for `brand.manage`, `staff.manage` and `finance.evidence.manage` sensitive handlers. The guard ignores caller-supplied role/MFA claims, authenticates the opaque session through `SessionService`, requires persisted MFA freshness within 300 seconds, and audits both allow and denial decisions. Missing authentication returns 401; missing/stale elevation returns 403. It is exported by the identity module; a sensitive route must opt in with the metadata and guard. This backend currently has no brand, staff or finance-evidence action routes, so the guard is reusable enforcement infrastructure and is not evidence that those future operations already exist. Apply the normal permission, tenant-scope and mutation CSRF controls independently when those handlers are implemented.
# Brand access guard

`BrandAccessGuard` is exported by `AccessModule` for future brand-owned routes. A handler must use `@UseGuards(BrandAccessGuard)` and declare a stable permission with `@RequireBrandPermission('resource.action')`. The guard accepts identity only from one valid `__Host-renivet_session` cookie, authenticates it through `SessionService`, validates the route's `brandId`, and resolves either an exact brand grant or an applicable global grant through `access.effective_permissions`. It does not trust request body, query, or ad hoc `request.user` claims.

The guard is an early request check, not the data boundary. Repositories must use `buildBrandScopePredicate` in the same SQL statement for every protected resource alias so permissions are rechecked at query time. Permissions are deliberately not cached. Use short autocommit/READ COMMITTED operations: fresh statements see committed revocations, while in-flight statements and older transaction snapshots cannot be cancelled retroactively. The underlying view evaluates time windows using transaction-start `CURRENT_TIMESTAMP`. Keep CSRF and privileged MFA checks separate and apply them to the relevant mutation handlers.

There are no brand business routes in this slice. The guard and query contract are exercised by unit tests and disposable PostgreSQL fixtures rather than example production endpoints.
