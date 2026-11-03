# Catalog module — not implemented

Brand-owned products only; no universal SKU or catalog mutation implemented.

Boundary placeholder only; NestJS module is **not** imported into AppModule. Add application/domain/ports/controllers with tests after Phase 4 owner approvals.

## REN2-56 taxonomy persistence

The shared taxonomy tree is persisted by `0008_ren2_56_canonical_taxonomy.sql`. New categories start inactive and without a current schema pointer. Only leaf categories can publish a schema version; publication computes a SHA-256 hash over the ruleset, validator version, and typed attribute rules, then advances the category pointer. Published schema versions and their rules are immutable. Products and revisions retain an exact category/version pin, and revisions must match their parent product's pin.

Activation and retirement require transaction-local actor, request, and reason context and append an immutable availability event. The database context is an audit boundary, not proof of an authenticated human; the future application API must populate it only after global-admin authorization, MFA, and request validation. This task adds persistence and integration coverage only: it does not add routes or seed taxonomy data.
