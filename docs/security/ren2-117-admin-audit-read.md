# REN2-117 — AD-20 real immutable security audit read API

GET `/api/v1/admin/security-audit?limit=25&cursor=<event UUID>&action=<exact action>` queries existing append-only `access.security_audit_events`, joining `identity.users` for display identity. Requires **global Renivet Admin** role and permission `access_audit.read` through `PlatformPermissionGuard`. All SQL parameters bound; pagination by occurred_at/id, action filter validated. Excludes payload hashes and IP hashes from the response, does not mutate audit.

Frontend PR #81 adds the actual table, filters, errors and mobile cards.

Verify with a real global admin and negative brand-only/nonadmin requests, cursor pagination, empty results, strict expiry/403, hidden sensitive hashes, OpenAPI/generated types, CI, and 1280/390 screen comparisons before merge.
