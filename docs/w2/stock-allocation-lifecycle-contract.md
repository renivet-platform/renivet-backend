# Trusted allocation lifecycle contract

These are internal worker ports, not new public W2 HTTP routes. W3/W4 remain the owners of checkout, shipment, cancellation and refund orchestration. Every command requires a server-issued `WorkerAuthorizationContext`, a source outbox event for the same brand and checkout, an allowlisted effect, an idempotency key, and a current stock-pool row version.

## Dispatch

`dispatchTrusted` accepts a brand, allocation ID, dispatched quantity, expected balance version and idempotency key. It rejects a foreign allocation, stale version, terminal allocation, or quantity above the unshipped/unreleased remainder. In one PostgreSQL transaction it appends a commitment event decreasing A, then a physical movement decreasing P, updates the line's dispatched quantity/state, records the service actor/source event, writes the outbox event and immutable command receipt. Partial shipments can repeat with a new source event and key. A replay of the same source/key returns the stored result.

## Cancellation/release

`releaseTrusted` releases only `quantity - dispatchedQuantity - releasedQuantity` from A; it never changes P. It marks the allocation `CANCELLED`, keeps the dispatched counter for history, and records its receipt. Repeating cancellation with the same key cannot release twice. Allocation identity, accepted sequence and quantity are database protected; dispatch and release counters can only move forward.

## Paid but unavailable

When a verified accepted completion has no stock pool, a suspended pool, or insufficient ATS, allocation creates one immutable `stock_paid_unavailable_cases` row per checkout line/location and emits version-1 `inventory.paid_stock_unavailable`. The event tells W3 that reconciliation is required and includes the reason; it does not request a provider refund or claim one completed. A later duplicate delivery returns the same case and cannot allocate the line after this terminal outcome.

## Returns and stock buckets

The existing inventory return intake and independent review operations remain the return path: received units enter P and Q together, and become sellable only through reviewed quarantine release. Return acceptance does not reduce A for unrelated orders. Dispatch decreases P and A together; cancellation decreases only the remaining A. ATS continues to be `max(0, P - Q - U - A - B)`.

## Errors

The worker ports use stable codes including `WORKER_AUTHORIZATION_DENIED`, `WORKER_SOURCE_NOT_VERIFIED`, `STOCK_ALLOCATION_NOT_FOUND`, `STOCK_VERSION_CONFLICT`, `STOCK_DISPATCH_QUANTITY_INVALID`, `STOCK_ALLOCATION_NOT_DISPATCHABLE`, `STOCK_ALLOCATION_NOT_RELEASABLE`, and `IDEMPOTENCY_KEY_REUSED`.
