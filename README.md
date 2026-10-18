# Renivet backend — Phase 0.5 configuration hardening

New NestJS + Fastify **modular monolith** repository. No imported legacy modules.

- `src/modules/health` is active and serves `GET /api/v1/health`.
- `src/modules/{identity,catalog,inventory,cart,checkout,orders,payments,settlements,fulfillment,integrations}` are *reserved empty NestJS module shells*, **not** registered in `AppModule`.
- `src/common`: cross-cutting transport helpers; `src/infrastructure`: future technical adapters; `src/workers`: future backend-owned async processors.
- `src/db`: proposed Drizzle foundations. No domain migrations are executed.

See `docs/architecture.md` for layering and the `renivet-engineering-os/dev/README.md` for Windows local setup.

## Validated runtime configuration

Copy `.env.example` to ignored `.env` for local development. Run `npm ci` and `npm run dev`.
Health: http://127.0.0.1:4000/api/v1/health; OpenAPI: http://127.0.0.1:4000/docs.

`ConfigModule` runs `validateEnvironment` at startup. Defaults are deliberately limited to local/test mode: `NODE_ENV=development`, `HOST=127.0.0.1`, `PORT=4000`. Supplied connection URLs must have valid schemes and hostnames; the port must be 1–65535. In `NODE_ENV=staging` or `production`, explicit `DATABASE_URL`, `REDIS_URL`, `TYPESENSE_URL`, `TYPESENSE_API_KEY`, and `PYTHON_SERVICE_URL` are required. The known local Typesense key and PostgreSQL password are rejected in those environments. Error messages identify configuration keys but never echo their values. Validation does **not** test whether external services are reachable, provide authentication, or constitute production deployment approval.

`npm run deps:check` remains a **read-only localhost-only** developer connectivity test (PostgreSQL, Redis, Typesense, Python), not a production readiness check. Existing local `.env` files remain valid and are never committed.

Tests verify config validation, health and that unfinished commerce routes do **not** accidentally become public. Domain decisions remain In Review; automatic seller transfers are explicitly out of scope.
