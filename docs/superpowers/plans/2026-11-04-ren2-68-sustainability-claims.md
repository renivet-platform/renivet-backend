# REN2-68 Sustainability Claims and Evidence Lifecycle

## Goal
Implement REN2-68's two owned endpoints (`proposeProductClaim`, `listProductClaims`) and the supporting schema behavior. Brand proposals and evidence remain pending until REN2-69's independent moderation; a verified label is derived at read time and is suppressed when evidence is not accepted, clean, unexpired, or unrecalled.

## Constraints
- Use W1 server-derived brand permission and session-bound CSRF for writes.
- Keep evidence metadata and asset access brand scoped; never return storage keys or private URLs.
- Use additive Drizzle migration and PG16 integration proof.
- Preserve immutable review history; don't implement REN2-69's moderator endpoint or assign legal meaning to claims.
- Update executable OpenAPI, generated TypeScript SDK, and traceability for only the two owned operation IDs.

## Steps
1. Add focused service/controller tests for validation, pending-only writes, expiry/recall suppression, private URL exclusion, and safe cross-brand behavior.
2. Add additive schema support for claim expiry/revocation, evidence access ownership/state, review history integrity, row versions and idempotency receipts.
3. Implement repository transactions that recheck live permission, scope the product/revision and clean asset to the authorized brand, append audit history, and replay idempotently.
4. Expose POST/GET brand product claim endpoints with normalized DTO/error contracts, If-Match/idempotency/CSRF on mutation, and generated SDK updates.
5. Add disposable PostgreSQL 16 tests for constraints, atomicity, idempotency, tenant isolation and lifecycle suppression; add NestJS HTTP tests for authorization and endpoint behavior.
6. Run repo checks, inspect diff and security boundaries, then commit, push and open one PR to main. Stop without merging or enabling auto-merge.
