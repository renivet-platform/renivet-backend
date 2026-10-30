# Authentication and authorization guards

Role/tenancy enforcement must be server-side and deny by default. No placeholder guard is registered or assumed effective.

REN2-24 provides `@RequireMfa(action)` and `MfaGuard` for `brand.manage`, `staff.manage` and `finance.evidence.manage` sensitive handlers. The guard ignores caller-supplied role/MFA claims, authenticates the opaque session through `SessionService`, requires persisted MFA freshness within 300 seconds, and audits both allow and denial decisions. Missing authentication returns 401; missing/stale elevation returns 403. It is exported by the identity module; a sensitive route must opt in with the metadata and guard. This backend currently has no brand, staff or finance-evidence action routes, so the guard is reusable enforcement infrastructure and is not evidence that those future operations already exist. Apply the normal permission, tenant-scope and mutation CSRF controls independently when those handlers are implemented.
