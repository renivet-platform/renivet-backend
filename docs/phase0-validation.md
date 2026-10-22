# Phase 0.2 validation policy

- CI checks TypeScript, ESLint, compilation and an HTTP-injected health/404 test without accessing PostgreSQL.
- Current bootstrap has **no committed package-lock**; `npm install` is not a deterministic production supply-chain process. Track this as an explicit merge/production hardening gate.
- No actual database migration or checkout/inventory/finance transaction tests have executed.
- Health success is liveness only, not PostgreSQL/Redis/payment readiness.
- Never run `db:migrate` against a database without the future approved migration review/runbook.
