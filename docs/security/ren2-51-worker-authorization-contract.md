# REN2-51 global taxonomy and worker authorization contract

This is a backend contract for the approved W2 v1.5 policy. It does not activate taxonomy routes, W2 consumers, permissions, credentials, or production migrations.

## Global taxonomy administration

Global taxonomy writes use `@RequireGlobalTaxonomyPermission('taxonomy.manage')`; approval operations use `taxonomy.approve`. The decorator applies both `PlatformPermissionGuard` and `MfaGuard`. The first resolves a global permission from the authenticated W1 session with `brand_id IS NULL`; a brand membership or a client role claim cannot grant it. The second requires a persisted MFA step-up no older than five minutes and records the privileged decision through the existing MFA audit service. CSRF remains required for cookie-authenticated mutations. The two global permission names are not seeded by this change; owner-approved role grants remain a separate decision.

## Worker identity and scope

Every event handler must declare either system scope or brand scope. Brand-scoped event handlers also declare a purpose and an allowlist of effect keys. Registration fails unless a `WorkerAuthorizationPort` is configured. When an outbox event is converted into a job, the database-backed adapter persists an immutable job entitlement with service principal, source event, database-resolved brand, purpose and permitted effects. It calls an implementation-specific `WorkerPrincipalProvider` when binding and again before processing; this port represents service-to-service authentication and live revocation/entitlement lookup. No JWT format or credential transport is prescribed.

The adapter accepts only `media_asset` and `stock_event` source aggregates, resolves `brand_id` from their persisted rows under a shared lock, then checks that the live authenticated principal, consumer, job entitlement, source event, owner, purpose and effect set still agree. It compares any payload `brandId` claim with the database-resolved owner. A payload value never establishes scope. The returned authorization context carries the source event, job, brand, purpose, provenance and permitted effect keys; handlers must `await authorizeEffect(effectKey, targetBrandId)` for every brand-owned write. Authorization runs inside the same transaction as the inbox receipt and handler effects, so rejection rolls all of them back.

Denied decisions are written using a separate short transaction before the worker fails the job, so rejection remains auditable after the effect transaction rolls back. Allowed decisions commit atomically with the handler effects. The entitlement and audit tables are immutable/append-only. The audit stores worker actor, scoped `brand_id`, source event, source/target brand, purpose, effect key, decision, reason and authorization provenance. Retention duration is intentionally unspecified pending the privacy policy task.

## Activation boundary

No production W1 or W2 consumer is activated by REN2-51. A future handler must be separately reviewed against its explicit system/brand scope, exact event types, purpose, effects, target ownership checks and required release gates G07/G17 before activation.
