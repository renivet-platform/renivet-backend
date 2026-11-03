# Catalog module — no routes registered

Brand-owned products only; no universal SKU or catalog route is implemented.

The NestJS module is **not** imported into AppModule. Internal persistence and pure domain helpers can be used by later task slices without activating API routes.

## REN2-56 taxonomy persistence

The shared taxonomy tree is persisted by `0008_ren2_56_canonical_taxonomy.sql`. New categories start inactive and without a current schema pointer. Only leaf categories can publish a schema version; publication computes a SHA-256 hash over the ruleset, validator version, and typed attribute rules, then advances the category pointer. Published schema versions and their rules are immutable. Products and revisions retain an exact category/version pin, and revisions must match their parent product's pin.

Activation and retirement require transaction-local actor, request, and reason context and append an immutable availability event. The database context is an audit boundary, not proof of an authenticated human; the future application API must populate it only after global-admin authorization, MFA, and request validation. This task adds persistence and integration coverage only: it does not add routes or seed taxonomy data.

## REN2-57 typed attribute validation

`category-attribute-validator.ts` compiles the immutable attribute-rule snapshot addressed by a product or revision's category schema version. It supports text, integer, decimal, boolean, enum, multi-enum, date, and measurement values; checks scope, allowed values, cardinality, and canonical units; and produces stable error codes and attribute paths. Draft validation checks supplied values while submission validation also enforces default and conditional requiredness.

Conditional rules use a strict version 1 AST object shaped as `{ "version": 1, "root": <expression> }`. Expressions use only `all`, `any`, `not`, `eq`, `in`, `exists`, `gte`, and `lte`; field references are attribute codes in the compiled category snapshot. Unknown fields/operators, type mismatches, extra keys, and over-complex trees fail closed. No JavaScript, SQL, or dynamic expression evaluation is performed. The compiler accepts only `w2-attribute-validator-v1`; its result carries the category ID, immutable schema row ID/version, and validator version so callers can bind validation to the exact product or revision pin.

Variant option signatures are deterministic canonical JSON with sorted object keys. Attribute codes are unique within the snapshot so conditional field references cannot be ambiguous.
