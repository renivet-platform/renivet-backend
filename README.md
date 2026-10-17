# Renivet backend — Phase 0.4

New NestJS + Fastify **modular monolith** repository. No imported legacy modules.

- `src/modules/health` is active and serves `GET /api/v1/health`.
- `src/modules/{identity,catalog,inventory,cart,checkout,orders,payments,settlements,fulfillment,integrations}` are *reserved empty NestJS module shells*, **not** registered in `AppModule`.
- `src/common`: cross-cutting transport helpers; `src/infrastructure`: future technical adapters; `src/workers`: future backend-owned async processors.
- `src/db`: proposed Drizzle foundations. No domain migrations are executed.

See `docs/architecture.md` for how to add approved features without breaking module boundaries. Windows local setup remains in `renivet-engineering-os/dev/README.md`.

Run `npm install`, `npm run dev`. Health: http://127.0.0.1:4000/api/v1/health; OpenAPI: http://127.0.0.1:4000/docs. `npm run deps:check` is a read-only local connectivity test (PostgreSQL, Redis, Typesense, Python).

Tests verify health and that unfinished commerce routes do **not** accidentally become public. Domain decisions remain In Review; automatic seller transfers are explicitly out of scope.
