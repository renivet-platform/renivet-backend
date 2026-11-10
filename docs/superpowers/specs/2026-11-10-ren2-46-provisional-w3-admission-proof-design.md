# REN2-46 provisional W3 admission-proof design

## Intent

Provide useful W2-side support for REN2-91, REN2-92 and REN2-94 while W3 is still being built. W3 remains responsible for assigning verified acceptance order and deciding which checkout is eligible for each conflicting stock pool. W2 durably verifies and consumes W3's proof, serializes each pool, allocates stock, and exposes retry/dead-letter behavior through the existing PostgreSQL worker framework.

## Goals and limits

- Persist an immutable acceptance sequence, canonical request hash, and W3 eligibility proof in W2.
- Require a monotonically increasing per-pool eligibility sequence; later proofs wait until the previous head is allocated, recorded as paid-no-stock, or explicitly skipped by W3.
- Use the existing `DurableWorker`, jobs, outbox/inbox receipts, bounded retry and dead-letter tables. Do not add Kafka, BullMQ, a scheduler, or an active production consumer.
- Require the current trusted W1 worker authorization boundary and derive brand ownership from the persisted variant/location records.
- Keep the provisional adapter single-line. Reject multi-line commands until the owner-approved all-or-none policy exists.
- Keep COD, timeout thresholds, and payment/refund orchestration unimplemented. W3 must emit an explicit authorized skip proof to advance past a predecessor; W2 does not invent a timer.

## Proposed W3 event contract

W3 writes `checkout.accepted` after verified prepaid completion, with a positive brand-scoped `acceptedSequence`, canonical one-line array, and SHA-256 `requestHash`. The hash is over canonical JSON `{brandId, checkoutId, acceptedSequence, lines}`, where each line is `{checkoutLineId, variantId, locationId, quantity}` and lines are sorted by `checkoutLineId`.

When W3's overlap-aware admission coordinator identifies that checkout as the next eligible head for its stock pool, it appends `checkout.allocation_eligible` referencing the accepted event, sequence, request hash, the canonical line, and a positive monotonically increasing `eligibilitySequence` for `(brandId, variantId, locationId)`. W3 alone decides that this is the current head.

W3 may advance past an invalid or expired predecessor only by appending `checkout.allocation_skipped` with the same pool eligibility sequence and an allowlisted reason. W2 durably records the skip and advances the pool cursor; the W3 coordinator owns when a skip is justified.

## W2 behavior

The existing allocation transaction verifies the eligible event and referenced accepted event, canonical hash, authorized brand and exact line, then locks the pool's admission cursor before locking stock. It requires the W3 eligibility sequence to equal `lastConsumed + 1`. A later token returns retryable `CHECKOUT_ELIGIBLE_HEAD_NOT_READY`; the existing DurableWorker retries it with bounded backoff and dead-letters exhausted work. An exact replay returns the stored receipt. The allocation, paid-no-stock case, stock journal/outbox, W2 proof receipt and cursor advance are atomic.

An unregistered `CheckoutAdmissionEventHandler` consumes the two W3 event types through the existing `DurableWorker`. It will not be added to `AppModule`; production scheduling and the W3 auth adapter remain inactive. A W3 integration must implement the event contract before the provision can receive real work.

## Verification

Use disposable PostgreSQL 16 to prove competing eligibility tokens cannot overtake, duplicate proofs do not create duplicate effects, explicit skips advance exactly one head, wrong/missing proof is denied, and pool-specific jobs proceed independently. Reuse existing durable-worker crash/retry/dead-letter integration evidence and add handler-level before/after-commit replay coverage. This provision is not W3 FIFO implementation and does not satisfy release gates or activate routes.
