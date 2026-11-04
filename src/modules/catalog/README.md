# Catalog module — W2 taxonomy and product draft routes

Brand-owned products only; no universal SKU or broad catalog workflow is implemented.

The NestJS module is registered in `AppModule` for REN2-58 global taxonomy schema operations, REN2-59 brand-scoped category reads, and the REN2-61 parent-product draft lifecycle. Other catalog and product APIs remain inactive.

## REN2-60 product and variant persistence

`catalogue.products` and `catalogue.product_variants` use stable UUIDs, brand-scoped normalized style/SKU keys, same-brand composite foreign keys, and an exact category/schema-version pin. Variant option-signature uniqueness is scoped to the parent product; callers must use the catalog's deterministic canonical option-signature function before persistence. These records remain brand-owned and do not represent multi-seller offers.

Migration `0010_ren2_60_variant_sku_order_lock.sql` adds a one-way `sku_locked_at` marker. The transaction that first accepts an order referencing a variant must set this marker atomically with the order reference. Once set, the database rejects SKU changes and attempts to clear or rewrite the lock. Order and checkout persistence are not implemented by this catalog slice, so the marker is a persistence contract for that future transaction, not an order workflow.

## REN2-56 taxonomy persistence

The shared taxonomy tree is persisted by `0008_ren2_56_canonical_taxonomy.sql`. New categories start inactive and without a current schema pointer. Only leaf categories can publish a schema version; publication computes a SHA-256 hash over the ruleset, validator version, and typed attribute rules, then advances the category pointer. Published schema versions and their rules are immutable. Products and revisions retain an exact category/version pin, and revisions must match their parent product's pin.

Activation and retirement require transaction-local actor, request, and reason context and append an immutable availability event. The database context is an audit boundary, not proof of an authenticated human; the future application API must populate it only after global-admin authorization, MFA, and request validation. This task adds persistence and integration coverage only: it does not add routes or seed taxonomy data.

## REN2-57 typed attribute validation

`category-attribute-validator.ts` compiles the immutable attribute-rule snapshot addressed by a product or revision's category schema version. It supports text, integer, decimal, boolean, enum, multi-enum, date, and measurement values; checks scope, allowed values, cardinality, and canonical units; and produces stable error codes and attribute paths. Draft validation checks supplied values while submission validation also enforces default and conditional requiredness.

Conditional rules use a strict version 1 AST object shaped as `{ "version": 1, "root": <expression> }`. Expressions use only `all`, `any`, `not`, `eq`, `in`, `exists`, `gte`, and `lte`; field references are attribute codes in the compiled category snapshot. Unknown fields/operators, type mismatches, extra keys, and over-complex trees fail closed. No JavaScript, SQL, or dynamic expression evaluation is performed. The compiler accepts only `w2-attribute-validator-v1`; its result carries the category ID, immutable schema row ID/version, and validator version so callers can bind validation to the exact product or revision pin.

Variant option signatures are deterministic canonical JSON with sorted object keys. Attribute codes are unique within the snapshot so conditional field references cannot be ambiguous.

## REN2-58 taxonomy administration

`POST /api/v1/admin/catalog/categories/{categoryId}/schema-versions` accepts a schema proposal whose `ruleset` is exactly `{ "attributes": [...] }`. Each entry identifies a pre-approved global attribute by `attributeId` and supplies its category code, product/variant scope, value type, allowed values, unit, requiredness, conditional AST and cardinality. The API checks that the persisted global attribute's ID, code, scope and type match, then compiles the complete snapshot with the pinned `w2-attribute-validator-v1` compiler. A successful response returns `previewDiff` with added, removed and changed attribute rules against the currently published version.

`POST /api/v1/admin/catalog/categories/{categoryId}/schema-versions/{version}/publish` requires a different authenticated global approver than the draft submitter. `taxonomy.manage` and `taxonomy.approve` are separate global W1 permissions; both routes require a persisted MFA step-up no older than five minutes and session-bound CSRF. Brand-scoped permissions and client-supplied roles never authorize these routes.

The proposal and publication use the taxonomy advisory lock and category-version pointer as a compare-and-swap. Publishing requires the next version, a live leaf category, a valid immutable ruleset, and a different approver. An inactive category with no retirement event can receive its first published schema; a retired category cannot receive a new publication. The transaction advances the pointer, records an append-only `catalogue.taxonomy_admin_events` audit event, and writes a `category_schema.published` outbox notice atomically. Idempotent retries return the saved receipt; reuse with a changed payload conflicts.

No categories, attributes or pilot seed data are inserted by this slice. Production taxonomy seed approval remains a separate gate. The route output's `previewDiff` is a response extension on the proposed `ActionReceipt`; the v1.5 candidate operation remains the source contract for the operation and required receipt fields.

## REN2-59 brand category reads

`GET /api/v1/brands/{brandId}/categories` returns the shared tree in stable UUID keyset pages. Each item includes its parent, leaf and active flags, path codes, the current schema pointer, and the schema version (version 1 is the initial schema generation when a category has no publication yet). Inactive and non-leaf entries are informational and cannot be selected for product submission. Every request requires a live W1 `catalog.read` grant for the brand; the SQL read also checks the effective permission in the same statement.

`GET /api/v1/brands/{brandId}/categories/{categoryId}/attributes` pages only the current published version's frozen typed rules. Its opaque cursor is bound to that schema snapshot and becomes stale after publication. `GET /api/v1/brands/{brandId}/categories/{categoryId}/schema-versions/{version}` returns only the exact requested published snapshot, including its immutable ruleset hash and validator version; it never substitutes the latest version. These GET routes use private revalidation (`Cache-Control: private, no-cache`, `ETag`); requests re-read storage before returning 304, so category or schema changes are immediately visible.

See [REN2-61 progressive product drafts](REN2-61-product-draft.md) for the create/update contract and persistence behavior.

See [REN2-68 sustainability claims](REN2-68-sustainability-claims.md) for the proposal/evidence lifecycle and effective verified-state rules.
