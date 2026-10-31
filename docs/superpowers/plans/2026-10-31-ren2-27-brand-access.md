# REN2-27 Implementation Plan: Server-Resolved Brand Access

> Inline execution on `feature/REN2-27-server-resolved-membership-brand-query-scope`, based on `origin/main` at `0ab7ed44`. Do not merge without explicit owner approval.

**Goal:** Enforce brand permissions from the authenticated session and prevent cross-brand access in reusable SQL scope helpers across all requested query shapes.

**Architecture:** Reuse `SessionService`; add a permission-declared Nest guard backed by `access.effective_permissions`; attach a non-forgeable authorized scope context; build a parameterized SQL predicate that applies brand and live-permission checks in the same resource statement. Verify behavior against disposable PostgreSQL temporary fixtures; create no real domain APIs or permanent fixture tables.

**Spec:** `docs/superpowers/specs/2026-10-31-ren2-27-brand-access-design.md`

## Task 1 — Shared session cookie parsing and guard unit tests

**Files:** `src/modules/identity/session.service.ts`, `src/modules/identity/auth.controller.ts`, `src/modules/identity/mfa.controller.ts`, `src/common/guards/require-mfa.ts`, `src/modules/identity/identity.module.ts`, `tests/*`

- [ ] Write tests for a shared cookie parser: exactly one valid `__Host-renivet_session` token is accepted; missing, malformed, duplicate session cookie, or multiple header values are rejected.
- [ ] Run tests and confirm failure before implementation.
- [ ] Export parser and use it in auth controller, MFA guard, and MFA controller without changing endpoint behavior.
- [ ] Export `SessionService` from `IdentityModule` for authorization infrastructure.
- [ ] Run focused unit tests and current OpenAPI/Postman checks.

## Task 2 — Session-backed, default-deny brand permission guard

**Files:** create `src/modules/access/access.module.ts`, `src/modules/access/brand-access.guard.ts`, `src/modules/access/brand-access.repository.ts`, and focused tests; modify `src/app.module.ts`.

- [ ] Write guard tests first: no permission metadata/malformed permission fails closed; absent/duplicate/invalid session is unauthorized; missing or malformed brand ID is denied; caller body/query/`request.user` claims never become the actor; denied permission is generic; DB outage fails closed; authorized multi-brand scopes are attached to the request.
- [ ] Run tests and confirm the expected failures.
- [ ] Add `@RequireBrandPermission`, guard and repository; query `access.effective_permissions` without a cache. Allow either a matching global permission or matching permission scoped to the exact requested brand.
- [ ] Attach only the authenticated user ID, validated brand ID and declared permission as an opaque authorized-scope object.
- [ ] Register the provider module without adding routes; run focused guard tests and typecheck.

## Task 3 — Same-statement tenant predicate and query-shape integration

**Files:** `src/modules/access/brand-access.guard.ts`, `tests/brand-access.integration.test.cjs`; modify CI.

- [ ] Write PostgreSQL 16 integration cases first using only temporary synthetic resource tables.
- [ ] Prove positive brand A, brand B and multi-brand reads; prove absent scope fails closed.
- [ ] Exercise detail, list, search, count, nested, bulk update and export with the shared parameterized scope helper.
- [ ] Attempt guessed Brand B IDs from Brand A for every fixture shape; verify no data, counts or writes leak.
- [ ] Capture a valid scope then revoke/expire the grant or suspend/expire the membership; the same context's next SQL statement must return no rows/counts and change zero rows. No permission cache is allowed.
- [ ] Add CI invocation after migrations and on the disposable PostgreSQL 16 service. Do not add fixture endpoints or migration tables.

## Task 4 — Documentation and full verification

**Files:** `src/modules/README.md`, `src/common/guards/README.md`, `tests/README.md`, `.github/workflows/ci.yml`.

- [ ] Document how future route handlers declare permissions, obtain server scope, and apply same-statement predicates; note CSRF/MFA are separate controls.
- [ ] Run `npm run typecheck`, `npm run lint`, `npm run api:check`, `npm test`, focused PostgreSQL authorization integration, and Drizzle schema consistency check.
- [ ] Run full PostgreSQL 16 integration/recovery CI-equivalent checks against the disposable service only.
- [ ] Review full diff, `git diff --check`, role matrix behavior, errors/fail-closed paths, and acceptance mapping. Get a fresh read-only code review. Create a PR; do not merge.

## Acceptance boundaries

- AC-01..03 are demonstrated by the guard and SQL integration tests; no real business tables or public routes exist yet.
- AC-04 is complete only when the CI workflow containing the focused PostgreSQL suite passes.
- Exact route-specific response/enumeration behavior, OpenAPI, and Postman coverage remain required when a real resource endpoint is later added.
