# REN2-50 — W1 to W2 PostgreSQL 16 migration review

## Scope and source

Migration `0006_ren2_50_w2_catalog_inventory.sql` is the backend-reviewed W2 v1.5 SQL candidate, applied after the exact W1 Drizzle sequence `0000` through `0005`. The source candidate is not treated as deployment approval; this migration is exercised only by the disposable PostgreSQL 16 CI service and task-local tmpfs container. A production rollout still requires the owner's normal release approval.

The migration adds four W2 schemas (`catalogue`, `media`, `imports`, `inventory`) and 38 W2 tables. It reuses `brands.brands(id)` for brand references. It does not create a second identity or brand root, alter W1 schemas/tables, drop objects, or define `ON DELETE CASCADE` behavior. The DDL includes W2-local composite foreign keys, audit/event structures, immutability and lifecycle triggers, and the approved-price window exclusion constraint.

## PostgreSQL requirements

- PostgreSQL 16.
- `btree_gist` must be available and installable by the migration role. It supports the GiST exclusion constraint over `brand_id`, `variant_id`, `currency`, and the half-open `[)` validity range for approved prices.
- Drizzle applies this migration using the checked-in journal and `--> statement-breakpoint` markers. The migration is additive and has no destructive down migration; use the disposable database rebuild/recovery process for test rollback.

## Verified behavior

`tests/w2-schema.integration.cjs` is run after Drizzle migration and again after the CI recovery rebuild. It confirms:

- The W1 brand root remains present and no duplicate brand root appears in W2 schemas.
- Exactly the reviewed 38 candidate W2 tables exist in the four W2 schemas.
- The approved price exclusion and `btree_gist` extension are present.
- The approved price exclusion is partial to approved rows, and the unique QC decision index is partial to approved decisions.
- A product referencing an unknown W1 brand is rejected by PostgreSQL FK enforcement.
- Adjacent approved price ranges are accepted; an overlapping approved range is rejected.
- Failed fixture statements are rolled back and the W1 schema/column signature is unchanged.

The migration's constraints do not replace request-level authorization, catalog validation, inventory transaction services, event journaling invariants, or operational review. Those are owned by later W2 tasks and remain inactive until implemented and reviewed.
