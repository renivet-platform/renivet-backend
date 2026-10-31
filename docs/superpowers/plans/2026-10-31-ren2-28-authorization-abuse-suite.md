# REN2-28 Authorization Abuse Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce repeatable CI evidence for T-AZ-01..09 and T-ID-09 using the actual session, brand guard, live SQL predicate, MFA audit and access-audit persistence already implemented.

**Architecture:** Extend existing PostgreSQL 16 disposable integration coverage and MFA guard/API tests; add no product routes or schema. The real backend guards, permission view, query predicate and audit persistence remain the code under test. Synthetic fixtures are rolled back or cleaned only in the isolated CI database.

**Tech Stack:** NestJS 12, PostgreSQL 16, node:test, Fastify test server, existing Drizzle schema and GitHub Actions.

**Spec:** Linear REN2-28 (`https://linear.app/renivet/issue/REN2-28/w1-b3-verify-revocation-privileged-decisions-and-cross-tenant-abuse`) and `C:/Renivet/renivet-engineering-os/docs/02-system-design/w1-kernel-acceptance-matrix.md`.

## Global Constraints

- Do not create real catalog, order, inventory, membership-administration or finance APIs just to exercise authorization.
- Use synthetic principals and disposable PostgreSQL 16/Redis only; never use shared, staging or production services.
- Permission scopes are derived from authenticated session and `access.effective_permissions`; tenant SQL checks remain in the resource statement.
- Keep role grant/removal evidence append-only and exclude credentials, OTP/TOTP, recovery codes, session tokens and raw IPs from audit metadata.
- No schema migration, API contract, Postman endpoint, provider call, deployment, merge or Linear state transition is in scope.

## Review Focus

- Missing or forged principal/brand/role claims must deny without revealing another tenant's data; exercise against the real guard and parameterized predicate.
- A previously issued scope must stop working after grant or membership expiry/revocation; exercise through a fresh SQL statement.
- Pending, suspended, expired and unapproved access must deny; include all states in the effective-permission suite.
- Sensitive actions must deny stale/missing MFA and emit safe audit evidence; verify persisted audit rows contain no factor/session material.
- Test fixtures must not leave immutable access-audit rows behind; use rollback for access-audit assertions.

---

### Task 1: Map the threat matrix to executable tests

**Files:**
- Modify: `tests/brand-access.integration.test.cjs`
- Modify: `tests/brand-access-guard.test.cjs`
- Modify: `tests/mfa-guard.test.cjs`

**Interfaces:**
- Consumes: `BrandAccessGuard`, `buildBrandScopePredicate`, `MfaGuard`, and current `access.effective_permissions`/session contracts.
- Produces: named executable coverage for T-AZ-01..09 and T-ID-09 with explicit expected allow/deny, safe response, and unchanged-data assertions.

- [x] **Step 1: Add cases** for a no-grant account with forged admin/brand/MFA request claims, unapproved-brand and role-revocation paths, and privileged action without persisted elevation.
- [x] **Step 2: Run focused tests**; correct the test fixture to use a separate active non-elevated session because MFA step-up intentionally rotates and revokes its input session.
- [x] **Step 3: Confirm no production fix was needed**; existing guards and predicates enforced the policy, so no domain endpoints or production behavior changes were added.
- [x] **Step 4: Re-run focused tests** and record the T-AZ/T-ID case mapping in `tests/README.md`.

### Task 2: Verify audit evidence and secret redaction

**Files:**
- Modify: `tests/brand-access-schema.integration.cjs`
- Modify: `tests/mfa-api.integration.test.cjs`

**Interfaces:**
- Consumes: append-only `access.security_audit_events`, persisted MFA security events and existing tested factor/session lifecycle.
- Produces: rollback-safe grant/revoke/admin-denial audit checks plus MFA decision audit checks that prove no sensitive material is stored.

- [x] **Step 1: Add audit assertions** for synthetic role grant/removal and guarded MFA denial/allow behavior.
- [x] **Step 2: Run the focused disposable integration cases** and verify both decisions produce persisted audit evidence.
- [x] **Step 3: Use the existing audit contracts**; access-audit assertions stay inside the test transaction and MFA fixtures use existing cleanup.
- [x] **Step 4: Verify** action, subject, request/hash metadata, decision and secret-redaction assertions.

### Task 3: Make REN2-28 a required disposable CI gate

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: PostgreSQL/Redis services and test commands from Tasks 1–2.
- Produces: pull-request/push CI steps that fail on any negative-case regression and repeat relevant authorization checks after database recovery.

- [x] **Step 1: Add a CI invocation** using explicit disposable PostgreSQL/Redis endpoints and the disposable-service flag; auth keys are set synthetically by the existing MFA integration test.
- [x] **Step 2: Run the same focused suite locally** against disposable PostgreSQL 16 and Redis (8/8 pass); full local test suite also passes (85/85).
- [x] **Step 3: Ensure no `continue-on-error` or skipped-by-default path** masks REN2-28 cases; the CI step is required and runs the normal Node test assertions.

### Task 4: Record run instructions and evidence boundaries

**Files:**
- Modify: `tests/README.md`
- Modify: this plan

**Interfaces:**
- Consumes: executed tests and exact CI commands.
- Produces: operator-readable local setup/commands, scenario-to-test mapping and clear statement that future product endpoints require their own API/Postman coverage.

- [x] **Step 1: Document** each scenario's executable test and explicitly state the product-route coverage boundary.
- [x] **Step 2: Run full validation:** `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` (85/85), and `npm run api:check` all pass.
- [x] **Step 3: Review diff/status**; no secrets, local `.env`, generated contract drift, production code or migration changes are included.
