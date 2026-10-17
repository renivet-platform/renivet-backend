# Renivet backend — Phase 0

Fresh modular-monolith API foundation (NestJS + Fastify + Drizzle). No legacy code imported.

## Quick start

1. Install Node.js 22+ and PostgreSQL (or run `docker compose up -d` from engineering-os `dev/`).
2. `cp .env.example .env` and `npm install`
3. `npm run dev`
4. Visit `http://localhost:4000/api/v1/health` and `http://localhost:4000/docs`.

**Safety:** Do not run `db:migrate` against shared/production databases; the example system table is not approved D02 commerce DDL. No finance, payment, authentication or inventory implementations exist yet. CI does not deploy.
