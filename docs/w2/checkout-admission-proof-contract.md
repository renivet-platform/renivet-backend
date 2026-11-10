# Provisional checkout admission proof contract

**Status:** W2 consumer-side provision, pending a W3 producer and approval of the rollout gates. This document does not authorize public route activation, background worker registration, checkout admission, or release to production.

## Ownership boundary

W3 owns provider-verified prepaid acceptance, acceptance ordering, per-pool eligibility sequencing, and the decision that a predecessor may be skipped. W2 does not infer FIFO from HTTP arrival, worker claim order, timestamps, or PostgreSQL `SKIP LOCKED`; it validates and durably consumes W3 evidence.

The existing `checkout.accepted` outbox event remains the immutable source record. W3 must emit one of these follow-up events only after it has established the corresponding proof:

### `checkout.allocation_eligible` (event version 1)

```json
{
  "brandId": "<approved brand UUID>",
  "acceptedEventId": "<checkout.accepted outbox UUID>",
  "acceptedSequence": 123,
  "eligibilitySequence": 456,
  "requestHash": "<sha256 of canonical accepted request>",
  "line": {
    "checkoutLineId": "<UUID>",
    "variantId": "<UUID>",
    "locationId": "<UUID>",
    "quantity": 1
  }
}
```

The event must use `aggregate_type = checkout.order`, the same order UUID as `checkout.accepted`, one canonical line, and a monotonically increasing `eligibilitySequence` for the `(brandId, variantId, locationId)` pool. The line and request hash must exactly match the referenced accepted event. Sequences start at 1 and have no gaps except where a corresponding explicit skip proof is consumed.

### `checkout.allocation_skipped` (event version 1)

The payload has the same proof fields and line as `checkout.allocation_eligible`, plus `reasonCode`. W2 accepts only `PREDECESSOR_INVALID`, `PREDECESSOR_EXPIRED`, `PREDECESSOR_CANCELLED`, or `OPERATOR_RECOVERY`. W3 must be the authority for the skip decision; W2 does not create a timeout or expiry policy.

## W2 behavior

W2 verifies both event records, canonical line/hash, brand and pool, then serializes by a database cursor for that pool. Only `eligibilitySequence = last + 1` can be consumed. A later sequence fails with `CHECKOUT_ELIGIBLE_HEAD_NOT_READY`, which the existing durable worker retries with bounded backoff. A consumed or stale token fails closed. Allocation (including a durable paid-no-stock outcome), proof receipt, cursor advance, stock journal/outbox effects, and command receipt commit atomically. A skip receipt and cursor advance commit atomically without changing stock.

The per-pool cursor, common admission claim, proof, and skip rows are durable PostgreSQL evidence. These rows are append-only, and the common claim prevents one accepted order from being both skipped and allocated or from consuming multiple eligibility tokens. Retries of the same event are idempotent; changed payloads, event references, sequence values, SKU/location, quantity, hashes, or unauthorized brands fail closed. Worker authorization derives brand scope from the persisted variant and active warehouse rows; `payload.brandId` is checked against that scope and never establishes it.

The consumer class is intentionally **not registered** in `AppModule` or a running worker. The producer contract is a placeholder until W3 implements and tests it. Multi-line orders remain rejected pending an all-or-none rule. COD and payment/refund integrations remain out of scope.

## Release evidence still required

Before activation, W3 must implement the producer and demonstrate provider verification, monotonic pool sequencing, terminal outcomes, explicit predecessor skip rules, and replay/crash recovery. Engineering must review the proof contract and complete the applicable G04/G07/G17 runtime evidence gates. The W2 provisional tests only prove the consumer boundary against synthetic outbox evidence in disposable PostgreSQL 16.
