# REN2-26 Brand Access Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Implement the reviewed W1 brand membership, role/permission, scoped assignment, and permanent access-audit schema with disposable PostgreSQL proof.

**Architecture:** Extend the current Drizzle schema with the canonical D02 `brands.*` and `access.*` tables, seed the owner-reviewed first-slice permission matrix, and enforce cross-table scope with composite foreign keys. Keep all authorization audit rows append-only and test every migration constraint against PostgreSQL 16.

**Tech Stack:** NestJS repository conventions, TypeScript, Drizzle ORM/Kit, PostgreSQL 16, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-10-31-ren2-26-brand-access-schema-design.md`

## Global Constraints

- Use `identity.users.id` as the principal key and the canonical ERD `brands.brands.id` as the brand key.
- Grant no role to any user by default; default deny all unseeded actions.
- Do not add HTTP routes, OpenAPI operations, or Postman requests in this schema-only task.
- Never apply migrations to shared/staging/production databases; run tests only against disposable PostgreSQL 16.
- Never merge the resulting PR without explicit owner approval.
- Keep audit history append-only and retained; do not add automated cleanup.

## Review Focus

- Global assignment with brand ID or brand assignment without one: reject via check and composite FK.
- A role assigned under a different scope kind: reject at the database boundary.
- Duplicate active/durable membership or role grant: reject using unique indexes.
- Membership/assignment pointing at absent user or brand: reject via FK.
- Audit modification/deletion or unsafe action/payload metadata: reject, preserving history.
- A newly migrated database receives the role catalog but no user assignment.

---

### Task 1: Drizzle model and generated migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0005_ren2_26_brand_membership_permissions_audit.sql`
- Create/update: `drizzle/meta/0005_snapshot.json`, `drizzle/meta/_journal.json`
- Test: generated SQL review plus focused schema integration test in Task 2

**Interfaces:**
- Consumes: existing `identityUsers` table and platform schema helpers.
- Produces: Drizzle exports for canonical brands, memberships, role/permission catalog, assignments, and access audit events.

- [x] Add failing integration cases first for required tables, columns, FKs, unique indexes, status/scope checks, and no-user-grant role seeds.
- [x] Run the focused test and verify the expected failure is caused by missing REN2-26 tables/constraints.
- [x] Define Drizzle tables with ERD column names and explicit foreign keys; make scope references checkable through a composite `(id, scope_kind)` role key and matching assignment FK.
- [x] Add a typed, read-only effective-permissions view that filters invalid user, assignment, membership, and brand states.
- [x] Generate migration/snapshot offline, inspect the SQL for exactly the intended additive objects and bounded seed values.
- [x] Re-run the focused schema test against disposable PostgreSQL and confirm the relevant cases pass.

### Task 2: Disposable PostgreSQL security and lifecycle coverage

**Files:**
- Create: `tests/brand-access-schema.integration.cjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: migrated `brands.*` and `access.*` objects from Task 1.
- Produces: repeatable proof for REN2-26 AC-01..04.

- [x] Test valid global/brand assignments, membership lifecycle, seeded role grants, and synthetic audit insert.
- [x] Test that future/expired assignments, inactive memberships, and unapproved brands do not appear in effective permissions; prove regrant reuses the durable assignment row.
- [x] Test FK failures, duplicate membership/assignment, mismatched scope, invalid status/windows, malformed audit hashes/actions, and immutable audit rows.
- [x] Ensure test fixtures are synthetic and cleanup never deletes immutable audit fixtures; use a test-only transaction or isolated fixture IDs consistent with retention.
- [x] Add the integration suite to both initial migration verification and post-recovery verification in CI.
- [x] Run CI-equivalent migration replay and test command with a disposable PostgreSQL 16 database.

### Task 3: Record permission and retention contract

**Files:**
- Modify: `src/db/README.md`
- Test: review source-to-test traceability against REN2-26, SRS-AUTHZ-001/SRS-DATA-001, AZ-01/AZ-04, and T-DB-02..05

- [x] Document canonical ERD archive fingerprint and tables implemented.
- [x] Document the role/permission matrix, sensitive-action MFA boundary, no preassigned users, and permanent append-only audit policy.
- [x] Document migration/recovery limits and that API/runtime authorization is deferred to REN2-27/28.

### Task 4: Full verification and PR-ready review

**Files:** all changes above

- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run `npm run build`.
- [x] Run `npm run api:check` (confirm there is no API contract change).
- [x] Run `npm test`.
- [x] Run the full PostgreSQL 16 disposable CI integration set, including the new REN2-26 test and recovery re-check.
- [x] Review `git diff --check`, migration SQL/snapshot and full diff; list any unpassed criterion explicitly.
- [x] Prepare a PR description with issue/requirements/decision IDs, schema/compatibility, threat cases, test output, and remaining runtime/frontend work. Do not merge.
