# REN2-21 Registration and Password Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement tested, documented first-party email registration and verified-email password login in `renivet-backend`.

**Architecture:** A NestJS identity module implements only the two documented candidate operation paths with a proposed contract pending per-slice D04 owner signoff. The module delegates to an application service backed by PostgreSQL and Redis. Argon2id hashes credentials, Redis applies atomic throttles, PostgreSQL stores canonical users, credentials, and digested opaque sessions. NestJS decorators generate the versioned OpenAPI document; a local Postman v2.1 collection runs as part of disposable integration CI.

**Tech Stack:** NestJS 12, Fastify, PostgreSQL 16, Redis 7, `pg`, `argon2`, `ioredis`, `class-validator`, `class-transformer`, Nest Swagger, OpenAPI Typescript, Postman CLI.

**Spec:** `docs/superpowers/specs/2026-10-28-ren2-21-registration-password-auth-design.md`

## Global Constraints

- Argon2id minimum: `m=19456 KiB, t=2, p=1`; password length 15–128; no plaintext storage.
- Canonicalize email using lower(trim(email)); do not link identities or replace existing account credentials.
- Registration is enumeration-neutral; login failures share one status and response.
- Require disposable PostgreSQL 16 and Redis 7 for integration tests; test only loopback services.
- Keep D04/source status honest: auth paths are selected from documented candidates; the source-verified D04 starter does not contain their DTOs, and the current Linear issue requires per-slice signoff.
- Do not update Postman Cloud, use production credentials, run shared DB migrations, or merge.

## Review Focus

- Concurrent duplicate registration: database uniqueness permits one account and both public responses remain equal.
- Unknown, unverified, inactive, and wrong-password login: same public failure shape and comparable password-hash work.
- Redis outage: authentication and registration fail closed without fallback to unthrottled operation.
- Session secret: only SHA-256 digest persists; cookie is Secure, HttpOnly, SameSite=Lax, host-only, and Path=/.
- Validation and exceptions: no email, password, hash, cookie, or credential URL appears in logs, responses, or committed examples.

---

### Task 1: Password policy and Argon2id primitives

**Files:** Create focused password policy/hash service and unit tests; update dependency manifest/lock and CI hash benchmark.

- [x] Write password-policy, Argon2id parameter/PHC, and verification tests; observe them fail before implementation.
- [x] Implement Argon2id at the owner-approved minimum, unique library salt, and safe generic verification behavior.
- [x] Run focused tests (2/2) and a real parameter benchmark; local median was 24 ms across 3 samples.

### Task 2: Redis rate-limit adapter and configuration

**Files:** Create atomic Redis limiter; update environment validation and examples; add Redis disposable service to CI.

- [x] Write per-account/IP window, threshold, fail-closed outage, and concurrent lazy-connection tests; observe initial RED before implementation.
- [x] Implement atomic Redis fixed-window limits and HMAC-derived opaque keys; keep failures redacted.
- [x] Run unit/config checks and HTTP integration against disposable Redis 7.

### Task 3: Registration/password session API

**Files:** Create identity DTOs/controller/service/repository/exception filter; import IdentityModule; add unit and PostgreSQL/Fastify tests.

- [x] Add unit and HTTP acceptance tests for registration, enumeration resistance, validation, concurrency, login denials/success, cookie attributes, digest-only storage, and rate limits.
- [x] Implement parameterized transactions using existing REN2-20 tables; add no migration.
- [x] Run HTTP acceptance against a fresh disposable PostgreSQL 16 and Redis 7; the first concurrent request exposed and fixed a Redis connection race.
- [x] Confirm authentication code emits no submitted credentials or contacts to logs or public error bodies.

### Task 4: OpenAPI and generated types

**Files:** Create generated OpenAPI JSON, export/check scripts, and generated TypeScript contract; update package scripts and CI drift checks.

- [x] Add a contract test for the implemented route/status/body/cookie/error schemas.
- [x] Implement Nest Swagger generation and deterministic contract/type drift checks.
- [x] Generate OpenAPI and TypeScript types; verify drift checks reject deliberate temporary drift and pass after restoration.

### Task 5: Local Postman collection and CI run

**Files:** Create versioned auth collection with positive/negative requests, synthetic variable placeholders, examples, and assertions; run Postman CLI against the disposable app in CI.

- [x] Add a structure/drift check that fails when a Postman request does not map to a real OpenAPI operation.
- [x] Run Postman CLI against the live disposable API with runtime-only synthetic credentials (6 requests, 8 assertions).
- [x] Keep handwritten assertions separate from generated artifacts; no Cloud sync was performed.

### Task 6: Full verification and handoff

- [x] Run typecheck, lint, build, unit/API tests, PostgreSQL/Redis integration, OpenAPI drift, generated-client drift, Postman CLI, npm audit, and repository security-policy checks.
- [x] Finish diff review and prepare Draft PR #22 without merging.
- [ ] Obtain owner D04 route/DTO signoff for the proposed contract before a merge or Linear Done transition.
