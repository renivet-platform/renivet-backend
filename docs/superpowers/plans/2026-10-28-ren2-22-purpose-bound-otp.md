# REN2-22 Purpose-Bound OTP Challenges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement tested email/phone OTP issue and verify workflows with purpose binding, durable one-use PostgreSQL state, Redis abuse controls, and fake-only delivery.

**Architecture:** NestJS routes call an OTP application service. `identity.auth_challenges` remains the durable challenge authority; Redis provides HMAC-keyed limits and short-lived locks. The default adapter performs no network I/O; integration tests inject an in-memory fake.

**Tech Stack:** NestJS 12, Fastify, PostgreSQL 16, Redis 7, `pg`, `ioredis`, Nest Swagger, OpenAPI Typescript, Postman CLI.

**Spec:** `docs/superpowers/specs/2026-10-28-ren2-22-purpose-bound-otp-design.md`

## Global Constraints

- Six-digit CSPRNG codes; 300-second TTL; five failed attempts; 60-second resend cooldown; three per destination/purpose per 900 seconds, all configurable.
- PostgreSQL stores only HMAC-SHA-256 code digests and canonical challenge metadata; no raw OTP in PostgreSQL, Redis, logs, fixtures, docs, or examples.
- Redis outages fail closed. PostgreSQL row/advisory locking owns atomicity and replay protection.
- Fake adapters only in tests. No actual provider calls or live credentials.
- Do not add routes beyond the two Engineering OS candidates; keep proposed route/DTO contract visibly gated in the Draft PR.
- No shared DB migration, deployment, Postman Cloud sync, Linear status change, or merge.

## Review Focus

- Two simultaneous issue requests for one user/channel/purpose leave only one active challenge; verify that prior challenge is denied.
- Two simultaneous correct verifications yield exactly one success; attempt counters never go negative or past five.
- Wrong channel/purpose, changed contact, unknown challenge, expiry, wrong code, exhausted, and reused cases fail generically.
- Redis unavailable or lock acquisition denied causes no challenge insert/consume and no provider call.
- Provider send failure invalidates the issued challenge; logs/responses never include raw destination, code, HMAC, or provider error details.

---

### Task 1: OTP configuration and Redis challenge locking

**Files:** Modify `src/config/environment.ts`, `.env.example`, `src/modules/identity/rate-limiter.ts`; tests in `tests/config.test.cjs` and `tests/identity-rate-limiter.test.cjs`.

- [x] Add protected-environment validation for a dedicated `AUTH_CHALLENGE_HMAC_KEY` and bounded OTP defaults.
- [x] Add `withLock(scope, identity, ttlMilliseconds, task)` to the Redis limiter using a random owner token, HMAC-keyed lock key, NX/PX acquisition, and compare-before-delete release.
- [x] Add RED/GREEN tests for invalid OTP config, exclusive concurrent lock, lock contention, release after throw, and fail-closed Redis errors.
- [x] Run focused tests, `npm run typecheck`, and `npm run lint`.

### Task 2: OTP service and provider boundary

**Files:** Create `src/modules/identity/otp-challenge.service.ts`, `src/modules/identity/otp-delivery.ts`; tests in `tests/identity-otp-service.test.cjs`.

- [x] Write tests for CSPRNG six-digit code shape, contact/channel/purpose normalization, HMAC binding, provider failure, unknown-contact neutral result, and no provider call on throttle failure.
- [x] Implement issue/verify orchestration and an unavailable default delivery adapter; inject a fake in tests only.
- [x] Use constant-time digest comparison, generic invalid challenge errors, and the approved configurable thresholds.
- [x] Run focused service tests and full unit suite.

### Task 3: PostgreSQL atomic challenge repository

**Files:** Extend `src/modules/identity/identity.repository.ts` with challenge operations; create `tests/otp-challenges.integration.test.cjs`.

- [x] Add CI integration coverage for active challenge replacement, durable attempts, expiry, wrong-purpose, contact changes, verified-contact update, and atomic one-use concurrency.
- [x] Implement parameterized queries and transactions against existing `identity.auth_challenges`/`identity.users`; use advisory transaction locks for issue and `FOR UPDATE` for verify.
- [x] Confirm no migration changes are needed; the schema matches the existing REN2-20 table.
- [ ] Run PostgreSQL integration tests against disposable services (workstation Docker daemon is unavailable; CI verification remains pending).

### Task 4: DTOs, routes, OpenAPI, and Postman

**Files:** Create `src/modules/identity/otp.dto.ts` and `otp.controller.ts`; modify `identity.module.ts`; regenerate `openapi/renivet.openapi.json` and `src/generated/api-schema.d.ts`; create/update `postman/collections/renivet-backend-otp.postman_collection.json` and contract tests.

- [x] Write local route tests and disposable-service integration coverage for generic issue responses, valid verification, wrong/expired/reused/purpose-mismatched denials, rate limiting, provider outage, and safe errors.
- [x] Implement only candidate `POST /auth/challenges` and `POST /auth/challenges/{challengeId}/verify`, with schemas/statuses/errors documented by Nest Swagger.
- [x] Add synthetic Postman request/response examples and positive/negative assertions; keep the handwritten collection separate from generated OpenAPI.
- [x] Run `npm run api:generate`, `npm run api:check`, and local HTTP contract tests. Disposable Postman execution is configured in CI and awaits that run.

### Task 5: CI, review, and handoff

**Files:** Modify `.github/workflows/ci.yml`, identity README, and this plan/ledger.

- [x] Add OTP integration/Postman step to the disposable PostgreSQL 16 + Redis 7 CI job; no production secrets or real provider calls.
- [ ] Run full CI verification, security policy checks, and diff review.
- [ ] Prepare a Draft PR from `feature/REN2-22-purpose-bound-otp-challenges`; do not merge or update Linear status.
- [x] Record the D04 route/DTO approval gate for owner review.
