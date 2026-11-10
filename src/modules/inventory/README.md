# Inventory implementation boundary

REN2-83..89 now have an additive PostgreSQL ledger, brand-scoped repository operations, dormant NestJS controllers and PostgreSQL integration tests. `InventoryModule` is intentionally not imported by `AppModule`; the routes and their generated API contract remain unavailable until G07/G08/G17 are approved.

## Authoritative stock model

Follow Master A4 per `(brand, variant, location)` pool:

- `P`: physical on hand
- `Q`: quarantined portion of physical stock
- `U`: other non-sellable portion
- `A`: allocated but not physically dispatched
- `B`: safety buffer
- `ATS = max(0, P - Q - U - A - B)`

There is one allocation bucket. Do not separately subtract a committed-unshipped or pre-commit allocation counter. An allocation changes A once; physical dispatch changes P and releases the same quantity from A once.

External inventory feeds are timestamped observations and never overwrite P. A warehouse transfer deducts the source when dispatched, remains `IN_TRANSIT`, and credits the destination only in a separate receipt command.

Every zero stock pool gets an immutable zero-state genesis movement at sequence 1. Its first nonzero effect starts at sequence 2. Opening stock is an idempotent first receipt that creates the pool, genesis, physical movement and outbox rows in one transaction. Observation freshness is surfaced using the W2 manual (24/48 hour) and connected (15/60 minute) thresholds. Public submissions are always treated as manual; a connected clock requires a trusted connector. A current physical observation can create only a maker/checker adjustment proposal; authoritative P changes only after an independent approval records a movement.

Every adjustment proposal snapshots physical before/after values. `GET` adjustment history is brand-scoped and returns the immutable proposal, review and application audit entries. Physical movements are rejected when they would take ATS below zero against quarantine, unsellable units, allocations or buffer.

## Release boundaries

D05's adjustment threshold is stored as provisional until its source owner confirms it. W3 fulfillment cancellation/dispatch adapters and production service-principal wiring are not activated here. Add those only through their approved contracts; do not expose an unverified public substitute. The issue and gate tracking is in the Engineering OS W2 activation-gates document.
