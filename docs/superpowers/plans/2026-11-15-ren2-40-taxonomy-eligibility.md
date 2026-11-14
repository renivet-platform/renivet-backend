# REN2-40 Taxonomy and Brand Eligibility Implementation Plan

> **For agentic workers:** Native execution is authorized by the owner activation. Execute only the two scoped child issues in dependency order; tests precede production changes.

**Goal:** Deliver the owner-approved Pilot v1 apparel taxonomy and connect an authorized W1 brand approval outcome to existing catalog eligibility without creating a parallel role, membership or application workflow.

**Architecture:** Represent taxonomy data as a versioned fixture consumed by validation and existing taxonomy lifecycle code. Implement REN2-55 as a narrow internal port backed by W1 brand state and append-only audit; retain existing permission and active joined membership checks as the effective catalog gate.

**Tech Stack:** NestJS 12, TypeScript, PostgreSQL 16, Drizzle migrations, node:test.

**Spec:** Linear REN2-54 and REN2-55; W2 v1.5 master specification, SOP-W2-01, G07/G13/G17; owner-approved decisions in this conversation.

## Global Constraints

- Use canonical W1 rands.brands, rands.brand_memberships, and ccess.effective_permissions.
- Do not add public onboarding routes, seed roles/grants, fabricate compliance/legal rules, or create inventory locations/stock.
- Require authorized W1 review permission, independent checker and append-only provenance for approval outcomes.
- Preserve fail-closed behavior for unapproved, rejected, suspended or revoked access.
- Do not mutate existing databases; PostgreSQL integration is disposable PG16 only.

## Review Focus

- Unapproved or suspended brands cannot gain catalog access (W1 effective-permission regression test).
- Replayed approval events cannot duplicate membership/role or audit effects (idempotency test).
- Same maker/checker cannot approve (negative independent-review test).
- Taxonomy categories and controlled values remain stable/versioned, and categories with unknown compliance obligations are explicitly gated rather than given invented fields.
- Invalid, non-leaf or incomplete schema data is rejected by the existing validator/lifecycle.

---

### Task 1: REN2-54 approved Pilot v1 taxonomy fixture

**Files:** versioned taxonomy data under src/modules/catalog/taxonomy/; fixture validation test under 	ests/w2/; acceptance/retirement policy note under docs/w2/.

- [ ] Encode the eight owner-approved apparel categories and shared/category-specific fields with stable codes, typed values and units.
- [ ] Record Catalog Operations and Pilot v1 provenance; keep legal/certification requirements limited to already-approved W2 policy and mark any counsel/merchant determination explicitly gated.
- [ ] Add tests for unique stable codes, tree leaf shape, valid vocabularies/units and required compliance-gate metadata.
- [ ] Validate via node:test and relevant taxonomy validator tests; commit as eat(REN2-54): add approved pilot taxonomy dataset.

### Task 2: REN2-55 W1 onboarding eligibility handoff

**Files:** internal eligibility service/port, W1 persistence adapter/migration if required, module wiring, PostgreSQL 16 integration tests, security handoff documentation.

- [ ] Accept only an authorized W1 brand review outcome; enforce global rand_membership.review, independent checker, stable event identity and audit provenance.
- [ ] Transition the canonical brand state idempotently; never create memberships, assignments, roles or stock locations.
- [ ] Verify downstream eligibility still requires approved state and an active joined W1 membership; rejected/suspended/revoked state stays denied.
- [ ] Test replay, cross-brand isolation, unauthorized actor, same checker, suspended/rejected state and rollback against disposable PG16.
- [ ] Commit as eat(REN2-55): connect W1 approval to catalog eligibility.

### Epic integration

- [ ] Run backend lint, typecheck, tests, build, API checks and relevant disposable PostgreSQL 16 integration/recovery checks.
- [ ] Review full diff and current origin/main drift; push the epic branch and open one backend PR only if all scoped acceptance and required gates are satisfied.
