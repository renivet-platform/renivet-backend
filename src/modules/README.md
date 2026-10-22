# NestJS modular monolith boundaries — Phase 0.4

`health` is the *only* active application module. The ten commerce/identity modules are empty NestJS registration shells intentionally **not imported into AppModule**.

When an approved capability is ready, build its own controllers, application services, domain entities and repository interfaces inside that module; add implementation and tests before registering the module in AppModule. Keep infrastructure adapters outside business-domain cores.

- A brand owns its own products and SKUs.
- PostgreSQL is authoritative for inventory, checkout, orders, outbox/inbox and ledger.
- Redis is ephemeral and Typesense search is a projection.
- Payment provider collects from customers; seller bank transfers are **manual external actions**, never scheduled or called through payment provider payout APIs.
- Owner decisions tracked in REN-GOV-001 must be approved before production logic and acceptance tests.

The lack of routes is intentional. Do not treat module scaffolding as a delivered capability.
