# REN2-74 — Versioned Typesense projection

`CatalogSearchProjectionConsumer` handles v1 publication lifecycle outbox events for published, restricted, and unpublished products. It is exposed as an internal `EventHandler` factory and is not registered with the default application or scheduled in production.

## Event and projection contract

The frozen outbox payload uses `eventVersion: 1`, the event ID, lifecycle, brand/product/revision/review IDs, publication and content versions, current publication state, content hash, reason, optional appeal reference, and a SHA-256 over the canonical payload. The worker rejects unknown payload fields, event/type/lifecycle mismatches, bad identifiers, and hash mismatches.

The search document contract is projection schema version 1: stable product UUID `id`, brand/category IDs, publication version, approved revision ID, style code, title, description, searchable text, and sorted variant SKUs. Documents come only from the immutable published revision snapshot. Restricting, unpublishing, or any current PostgreSQL state that is no longer publishable sends an idempotent delete tombstone.

Before an index write, the consumer resolves the source product and brand from PostgreSQL, checks the W1 worker authorization context and brand, locks the product row, and reads the latest authoritative published pointers. It never uses Typesense as the authority. An old PUBLISH event arriving after restriction therefore tombstones the current restricted state. A per-product PostgreSQL watermark rejects older projection versions and prevents same-version state mutation. PostgreSQL inbox receipts suppress duplicate deliveries.

## Failure and activation boundary

Typesense requests have bounded timeouts, safe error codes, and no response-body or credential logging. Failures use the existing durable worker retry schedule; exhausted jobs create durable dead-letter cases and invoke the optional `onDeadLetter` alert callback. Operator recovery retains existing authorization and immutable recovery audit requirements.

The repo has no approved W2 service principal adapter or alert destination and no production worker scheduler. This PR supplies the brand-scoped handler, adapter, authorization support, and tested alert callback seam, but does not activate a production worker. Connect an owner-approved principal and alert sink before registration. Keep G09 closed until worker authorization, Typesense collection schema/key, dead-letter alert delivery, and runtime recovery evidence are approved. This change adds no public API or W3 behavior.
