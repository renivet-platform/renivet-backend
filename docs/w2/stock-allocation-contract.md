# Trusted stock allocation command

REN2-90 adds an internal PostgreSQL command for allocating one verified prepaid checkout line. It is not an HTTP route and does not activate any W2 inventory route. A caller must supply the `WorkerAuthorizationContext` issued by the existing worker authorization port; no request payload may construct that context.

## Accepted source event

The source event must be a persisted `platform.outbox_events` row with:

- `aggregate_type = checkout.order`
- `event_type = checkout.accepted`
- `aggregate_id = checkoutId`
- payload `brandId` equal to the authorized brand
- payload `acceptedSequence` equal to the command's sequence
- exactly one canonical line matching the command's checkout line, variant, location and quantity

The trusted checkout boundary must emit `checkout.accepted` only after verified prepaid completion and attach its durable ordering proof and canonical lines. W2 checks the requested line against that persisted event; it does not create the acceptance inbox or claim to enforce overlap-aware FIFO. Those remain W3 responsibilities. Mixed/multi-line atomicity remains open; this single-line port rejects multi-line checkout events with `CHECKOUT_MULTI_LINE_POLICY_UNRESOLVED`. Unverified, COD-like, missing, cross-brand, mismatched-sequence, or unrelated source events fail closed with `WORKER_SOURCE_NOT_VERIFIED`. The live checkout, payment gateway, refund provider, COD policy, and W3 transport remain outside this command.

## Command input

`allocateTrusted(authorization, input)` accepts `brandId`, `checkoutId`, `checkoutLineId`, `acceptedSequence`, `variantId`, `locationId`, `quantity`, and `idempotencyKey`. Quantity and sequence are positive safe integers. The target SKU, brand, and active location must match an approved brand. Foreign or guessed inventory targets return the same non-disclosing `STOCK_TARGET_NOT_FOUND` response.

## Transaction and retry behavior

The command locks its idempotency receipt key and checkout-line/location key in sorted advisory-lock order, then locks the authoritative stock pool row. It checks `ATS = max(0, P - Q - U - A - B)`, increments only bucket A, and uses the stock row version as the per-pool journal sequence/CAS. Allocation, typed commitment event, before/after stock event, balance update, command receipt, and outbox event commit together.

An exact command replay returns its immutable receipt with `replayed: true`; a reused idempotency key with a changed payload fails with `IDEMPOTENCY_KEY_REUSED`. A repeated checkout line with a new idempotency key returns its existing allocation rather than allocating again. Insufficient or suspended stock records `PAID_STOCK_UNAVAILABLE` without changing stock or claiming that a refund occurred.

## Result and event

Results use `state = ALLOCATED` or `state = PAID_STOCK_UNAVAILABLE`, with `allocationId` (null when unavailable), `acceptedSequence`, `replayed`, and, on allocation, `eventSequence` and `balanceVersion`.

An allocation emits `inventory.stock.changed` with outbox `event_version = 1`. Its payload contains the stock-pool sequence, allocation and event IDs, source checkout event ID, accepted sequence, and before/after snapshots. The event schema version is distinct from the monotonically increasing pool sequence.

Service-authored receipts and stock events record the service principal and source outbox event. Human-authored inventory receipts continue to record `actor_user_id`. Order and order-line IDs remain references because this backend has no W3 order schema yet.

## Stable error codes

`STOCK_ALLOCATION_REQUEST_INVALID`, `WORKER_AUTHORIZATION_DENIED`, `WORKER_SOURCE_NOT_VERIFIED`, `STOCK_TARGET_NOT_FOUND`, `CHECKOUT_ALLOCATION_CONFLICT`, `STOCK_VERSION_CONFLICT`, and `IDEMPOTENCY_KEY_REUSED`.
