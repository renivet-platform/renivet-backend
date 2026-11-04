# REN2-66 Secure Media Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Implement the REN2-66 brand-scoped media upload intent, completion scan/derivative lifecycle, and status endpoints with private DigitalOcean Spaces storage.

**Architecture:** NestJS controller enforces W1 brand permissions and session-bound CSRF for mutations; application service validates bounded image metadata and rights attestation. PostgreSQL stores brand-owned asset state and derivative records. An S3-compatible Spaces adapter creates short-lived PUT/GET URLs and reads/writes only server-derived brand prefixes; ClamAV INSTREAM and Sharp are required before an asset can become CLEAN. External object writes use deterministic keys and idempotent retry; scanner/storage errors leave PENDING, while content/malware failures become REJECTED.

**Tech Stack:** NestJS 12, Fastify, Drizzle migrations, PostgreSQL 16, AWS SDK for JavaScript v3 S3 client/presigner, Sharp, ClamAV TCP INSTREAM.

**Spec:** REN2-66; W2 v1.5 master A2, SOP-W2-04A, candidate schema/OpenAPI operations beginMediaUpload, completeMediaUpload, getMediaAssetStatus; G04/G07.

## Global Constraints

- Only this issue's three assigned operations; product/variant association and ordering remain REN2-67.
- Use W1 BrandAccessGuard, access.effective_permissions, __Host-renivet_session, and CSRF rules; no client-supplied identity or brand authority.
- Spaces bucket stays private; upload object keys derive from server UUIDs and brand UUIDs, never user paths.
- Allow only bounded JPEG, PNG, and WebP raster images; compare declared MIME, detected magic bytes, exact length, and SHA-256.
- An asset becomes CLEAN only after malware scan and derivative writes succeed; no scan bypass or public URL fetch.
- Additive Drizzle migration only; run only against the disposable PostgreSQL 16 CI database.
- G04/G07/G17 remain release gates; no production activation claim.

## Review Focus

- A signed upload URL cannot write another brand key, exceed the declared byte length, or outlive the short intent expiry; test signed fields, scope, and expiry.
- MIME, byte length, optional declared hash, completed hash, and decoded format disagreement rejects without exposing the object; test each mismatch.
- ClamAV malware and scanner-unavailable outcomes differ: malware becomes REJECTED; unavailable remains PENDING and returns retryable service failure.
- Derivative or database failure cannot mark an asset CLEAN; deterministic object keys permit safe retries without duplicate rows.
- Cross-brand, revoked permission, and CSRF failures reveal no asset metadata or URL; test API and SQL scoping.

## File Structure

- Create the media module/controller/DTO/service/repository plus focused storage, scanner, and image-processor adapters.
- Create additive drizzle/0017_ren2_66_secure_media_lifecycle.sql and update drizzle/meta/_journal.json. The repo uses SQL migrations for these W2 tables; no parallel schema declaration is maintained.
- Add focused unit tests under tests/w2/ and disposable PG16 integration coverage under tests/.
- Regenerate openapi/renivet.openapi.json and generated SDK declarations; update traceability/docs only where the repository checker requires it.
- Register MediaModule and document required storage/scanner configuration without editing any pre-existing user-modified file.

### Task 1: Validation and media provider contracts

**Files:** create media unit tests; create DTO/service and storage/scanner/processor port interfaces.

- [x] Write tests for accepted image types/limits, normalization, safe file-name handling, and rights-state mapping.
- [x] Run focused tests and confirm expected failures.
- [x] Implement pure validation and narrow injected ports.

### Task 2: Private storage, scanner, and derivative adapters

**Files:** media storage/scanner/image processor adapters and adapter tests.

- [x] Test server-generated brand prefix, presigned expiry/header contract, private derivative metadata, ClamAV clean/infected/unavailable outcomes, and derivative dimensions.
- [x] Run focused tests and confirm expected failures.
- [x] Implement S3-compatible private Spaces operations, bounded ClamAV INSTREAM protocol, and deterministic WebP derivatives; keep all adapter failures fail-closed.

### Task 3: Database lifecycle and repository

**Files:** migration/journal, Drizzle schema, repository, PostgreSQL integration test.

- [x] Test intent persistence/idempotency, complete ownership scope, state transitions, rights/scan metadata, derivative persistence, and unchanged state on retries/errors.
- [x] Run unit tests and PG16 integration test to confirm expected failures.
- [x] Implement additive constraints/indexes and scoped SQL; verify the task test only targets the disposable PG16 database.

### Task 4: Protected API and contract

**Files:** module/controller, app registration, DTOs, generated OpenAPI/SDK, traceability test and docs.

- [x] Test begin/complete/status routes, W1 permission and CSRF failures, non-disclosing cross-brand results, idempotency conflicts, and exact candidate contract shapes/status codes.
- [x] Run focused NestJS tests and confirm expected failures.
- [x] Implement three assigned routes, register module, generate artifacts, and ensure attachment/ordering APIs remain out of this issue.

### Task 5: Verification and handoff

- [x] Run focused unit/integration/security tests plus repository lint, typecheck, full unit suite, build, API check, and CI-equivalent PG16 migration replay.
- [x] Review the complete diff for scope, secret leakage, unsafe URL/network behavior, SQL tenant isolation, migration correctness, and retry/idempotency issues, including an independent review.
- [ ] Stage only issue files, commit with REN2-66, push the fresh branch, open PR to main, report actual results and remaining release gates, then stop.
