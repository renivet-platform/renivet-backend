# Backend architecture — Phase 0.4

## Active dependency direction

```text
HTTP (Fastify) -> NestJS AppModule -> HealthModule -> HealthController
                           |
                    ConfigModule
```

All proposed identity/commerce Nest modules have **empty decorators only** and are deliberately *not* registered. No route, worker, provider adapter or irreversible data mutation is implemented for these domains.

## Future domain module convention

```text
src/modules/<domain>/
  <domain>.module.ts
  controllers/          (HTTP transport only)
  application/          (commands, queries, orchestrations)
  domain/               (entities, policies, events)
  ports/                (interfaces; no SQL/SDK imports)
```

Create the subdirectories only when there is approved implementation work. Dependencies should flow inward: transport -> application -> domain/ports; `src/infrastructure` implements ports and does not own business policy. Keep cross-domain coordination explicit, transactionally bounded in PostgreSQL and tracked through outbox/inbox when asynchronous.

## Approval and safety

- Await D01–D06 / REN-GOV-001 Phase 4 outcomes for RBAC, pricing, inventory hold expiry, privacy and ledger events.
- Renivet authority for stock; brand-owned product identity, no universal SKU.
- Parent checkout splits into seller orders; Razorpay customer collection separate from manual **external** seller transfers.
- Append-only double-entry ledger and proof-backed admin settlement marking after actual bank transfer are future approved workflows, not live Phase 0.4 code.
- No production credentials, migrations, background payment transfers or provider calls.
- Controllers must validate auth, brand scope and idempotency under approved contracts before business endpoints are registered.
- `/api/v1/health` is liveness only. Dependency checker is developer tooling, not readiness guarantees.

Status: architectural directory foundation / In Review.
