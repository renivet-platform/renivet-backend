# Renivet backend — Windows/local Phase 0.3

Fresh **NestJS + Fastify** modular monolith. No historical code, payment adapters, policies or live migrations imported.

Run `setup-windows.ps1` from `renivet-engineering-os/dev/scripts` first, then start local dependencies and the three applications.

```powershell
# From renivet-backend:
npm run dev
# New PowerShell tab, after PostgreSQL, Redis, Typesense and Python are running:
npm run deps:check
```

- Backend liveness: http://127.0.0.1:4000/api/v1/health
- Draft OpenAPI: http://127.0.0.1:4000/docs
- `deps:check` uses the ignored local `.env` and performs a read-only SQL `SELECT 1`, Redis `PING`, an authenticated Typesense collection listing, and a Python health request.
- `deps:check` intentionally rejects non-local service URLs and is disabled in `NODE_ENV=production`.
- These checks do **not** prove checkout, inventory, data migration, server-side cache wiring, or production readiness.

**Never run** `npm run db:migrate` on any shared/production database without an approved migration and rollback plan. D02 domain schema and business policy remain In Review. Node dependency lockfile and `npm ci` still need supply-chain review.
