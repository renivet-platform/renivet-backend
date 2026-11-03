# REN2-49 — W1 Identity and W2 Authorization Reconciliation

**Status:** implementation reconciliation for review; proposed W2 grants are not owner-approved runtime grants.

**Linear:** REN2-49 (W2-F0.01). **Prerequisites:** REN2-26 and REN2-27 are Done and present in `origin/main` at the task branch base (`a058cd2`).

## Decision and current boundary

W2 must reuse the W1 identity, canonical brand, membership, role, permission, audit, and session infrastructure. A requested `brandId` selects the tenant whose access is being requested; it is never evidence of that access. Before enabling any W2 operation, its permission must be deliberately granted through the W1 role/permission model and every data query must enforce the same brand and current permission in SQL. No W2 business API, permission seed, or worker principal is implemented by this issue.

This record reconciles the 44 candidate operations in the Engineering OS W2 v1.5 OpenAPI with the actual backend controls and the v1.5 role proposal. It does not create a new role/grant policy. `Proposed role` below is a functional candidate from v1.5; it is not a current W1 role code or assignment. `UNMAPPED` means no approved role mapping is evidenced and access must remain denied until an owner-approved mapping is implemented.

## Evidence and compatibility checkpoints

| Concern | W1 implementation/evidence | W2 compatibility rule |
|---|---|---|
| Identity and session | `identity.users`; opaque `__Host-renivet_session`; `SessionService` resolves the authenticated user. Request body, query, and caller-supplied user/role claims are not authority. | Reuse the existing user/session; do not add a second identity system or accept a client-selected principal. |
| Brand and membership | Canonical `brands.brands` and `brands.brand_memberships`; `access.effective_permissions` resolves active user, current assignment window, approved brand, and active joined membership. | Reference canonical brand/user keys. Do not introduce parallel W2 brand or membership roots. |
| Permission catalog | Seeded W1 role codes are `renivet_admin`, `renivet_support`, `brand_owner`, and `brand_staff`. Their current grants are access-administration/status/membership grants only; no W2 catalog, media, import, inventory, pricing, or taxonomy grants are seeded. | Every W2 permission remains deny-by-default until an explicit reviewed migration maps it to roles. Do not infer grants from role labels. |
| Request guard | `BrandAccessGuard` reads the session, requires a UUID `brandId`, and checks `access.effective_permissions`. Missing policy, bad scope, no grant, or repository failure fails closed. `BrandAccessContext` is server-issued. `PlatformPermissionGuard` separately checks a global W1 permission with `scope_type='global'` and `brand_id IS NULL`; it has no brand fallback. | Every brand operation must declare its permission and use the brand guard before business logic. `/admin/brands/{brandId}` remains brand-scoped; the `admin` path segment is not authority. Taxonomy operations use `PlatformPermissionGuard`; no global permission is seeded for taxonomy, so those operations remain denied. |
| Query/data isolation | `buildBrandScopePredicate(alias, context)` binds the brand, user, and permission and rechecks current permission in the same SQL statement. | Apply it to every parent/child alias and detail, list, search, count, export, bulk read/write, and mutation. A guard-only check is insufficient. |
| Revocation | Permission is not cached in the guard; the SQL predicate consults the current effective-permission view. Existing integration evidence exercises revocation/suspension at the next statement boundary. | A previously issued context must not preserve access after a committed permission or membership revocation. |
| Errors and disclosure | Guard denial uses the generic `BRAND_ACCESS_DENIED`; missing/foreign resource rows are expected to be indistinguishable at the query/service boundary. Infrastructure/policy configuration failures are distinct service/configuration errors. | Do not disclose foreign brand existence, counts, import results, media metadata, object keys, or signed URLs. Return the same absent-resource outcome for cross-brand and nonexistent IDs where applicable. |
| CSRF and MFA | `SessionService.validateCsrfRequest` is available for cookie-authenticated mutations. `MfaGuard` currently recognizes `brand.manage`, `staff.manage`, and `finance.evidence.manage`; it requires persisted MFA within 300 seconds and audits the decision. | CSRF must be wired on cookie-authenticated mutations. Privileged operations require an explicit MFA action mapping; current MFA action names do not map one-to-one to proposed W2 permissions. This issue does not invent that mapping. |
| Database | Shared `IdentityInfrastructure` owns the PostgreSQL pool. REN2-26 migration is additive and uses canonical W1 schemas. | Keep W2 resources/permissions compatible with this pool/schema and canonical FKs. No migration or shared database change is part of REN2-49. |
| Workers | Durable worker infrastructure is generic and not registered for W2; it does not establish a tenant principal. Payload brand/user fields are not trusted authorization. | Future worker must use an allowlisted internal principal, trusted persisted target/job entitlement, server-derived brand, scoped database access, idempotency, and immutable audit. This is a design/test requirement, not an implemented W2 capability. |

## Candidate operation-to-permission matrix (44 operations)

Guard lane: `brand` means W1 `BrandAccessGuard` plus same-statement scoped repository predicate. `platform-global-admin` means a separate platform-global authorization lane; never infer it from a brand grant or brand path. Candidate role names reproduce the functional v1.5 proposal where possible. Unmapped operations must not be enabled until the role and grant decision is approved.

| # | Method and path | Operation ID | Permission required by candidate | Guard lane | Proposed role / mapping status |
|---:|---|---|---|---|---|
| 1 | GET `/brands/{brandId}/categories` | `listCategories` | `catalog.read` | brand | Brand catalog reader (proposed); exact W1 role/grant UNMAPPED |
| 2 | GET `/brands/{brandId}/categories/{categoryId}/attributes` | `getCategoryAttributes` | `catalog.read` | brand | Brand catalog reader (proposed); exact W1 role/grant UNMAPPED |
| 3 | POST `/brands/{brandId}/products` | `createBrandProduct` | `catalog.write` | brand | Brand catalog editor (proposed); exact W1 role/grant UNMAPPED |
| 4 | GET `/brands/{brandId}/products` | `listBrandProducts` | `catalog.read` | brand | Brand catalog reader (proposed); exact W1 role/grant UNMAPPED |
| 5 | GET `/brands/{brandId}/products/{productId}` | `getBrandProduct` | `catalog.read` | brand | Brand catalog reader (proposed); exact W1 role/grant UNMAPPED |
| 6 | PATCH `/brands/{brandId}/products/{productId}` | `updateBrandProduct` | `catalog.write` | brand | Brand catalog editor (proposed); exact W1 role/grant UNMAPPED |
| 7 | POST `/brands/{brandId}/products/{productId}/variants` | `createProductVariant` | `catalog.write` | brand | Brand catalog editor (proposed); exact W1 role/grant UNMAPPED |
| 8 | PATCH `/brands/{brandId}/variants/{variantId}/prices` | `proposeVariantPrice` | `pricing.write` | brand | Brand pricing writer (proposed); exact W1 role/grant UNMAPPED |
| 9 | GET `/brands/{brandId}/variants/{variantId}/prices` | `listVariantPrices` | `pricing.read` | brand | UNMAPPED; v1.5 candidate role map names no pricing reader permission |
| 10 | POST `/brands/{brandId}/products/{productId}/submit` | `submitProductForReview` | `catalog.submit` | brand | UNMAPPED; not equivalent to `catalog.write` without approval |
| 11 | POST `/brands/{brandId}/products/{productId}/publish` | `publishApprovedProduct` | `catalog.publish` | brand | UNMAPPED; publication authority requires explicit decision |
| 12 | POST `/brands/{brandId}/products/{productId}/restrict` | `restrictPublishedProduct` | `catalog.restrict` | brand | UNMAPPED; restriction authority requires explicit decision |
| 13 | POST `/brands/{brandId}/media/uploads` | `beginMediaUpload` | `media.write` | brand | UNMAPPED; v1.5 candidate role map has no media permission |
| 14 | POST `/brands/{brandId}/media/zip-imports` | `createMediaZipImport` | `media.write` | brand | UNMAPPED; v1.5 candidate role map has no media permission |
| 15 | POST `/brands/{brandId}/product-imports` | `createCatalogImport` | `imports.write` | brand | UNMAPPED; v1.5 candidate role map has no imports permission |
| 16 | POST `/brands/{brandId}/product-imports/{batchId}/mapping` | `saveImportMapping` | `imports.write` | brand | UNMAPPED; v1.5 candidate role map has no imports permission |
| 17 | GET `/brands/{brandId}/product-imports/{batchId}/preview` | `getCatalogImportPreview` | `imports.read` | brand | UNMAPPED; v1.5 candidate role map has no imports permission |
| 18 | POST `/brands/{brandId}/product-imports/{batchId}/confirm` | `confirmCatalogImport` | `imports.confirm` | brand | UNMAPPED; confirm needs explicit separation from write |
| 19 | GET `/brands/{brandId}/product-imports/{batchId}/results` | `getImportResults` | `imports.read` | brand | UNMAPPED; v1.5 candidate role map has no imports permission |
| 20 | POST `/brands/{brandId}/product-imports/{batchId}/retry` | `retryImportFailures` | `imports.write` | brand | UNMAPPED; v1.5 candidate role map has no imports permission |
| 21 | GET `/brands/{brandId}/inventory/balances` | `listAuthoritativeBalances` | `inventory.read` | brand | Brand inventory observer (proposed); exact W1 role/grant UNMAPPED |
| 22 | POST `/brands/{brandId}/inventory/locations` | `createStockLocation` | `inventory.location.manage` | brand | UNMAPPED; location administration not covered by proposed inventory roles |
| 23 | POST `/brands/{brandId}/inventory/observations` | `submitStockObservation` | `inventory.submit` | brand | UNMAPPED; do not assume equivalent to `inventory.write` |
| 24 | POST `/brands/{brandId}/inventory/adjustments` | `proposeStockAdjustment` | `inventory.adjust.propose` | brand | Inventory proposer (proposed); operation-level permission mapping still required |
| 25 | GET `/brands/{brandId}/inventory/movements` | `listStockMovements` | `inventory.read` | brand | Brand inventory observer (proposed); exact W1 role/grant UNMAPPED |
| 26 | POST `/brands/{brandId}/inventory/cycle-counts` | `createCycleCount` | `inventory.count` | brand | UNMAPPED; count permission absent from role map |
| 27 | GET `/brands/{brandId}/inventory/reconciliations` | `listInventoryReconciliations` | `inventory.read` | brand | Brand inventory observer (proposed); exact W1 role/grant UNMAPPED |
| 28 | POST `/brands/{brandId}/inventory/reconciliations/{caseId}/resolve` | `resolveReconciliation` | `inventory.reconcile` | brand | UNMAPPED; reconciliation authority absent from role map |
| 29 | POST `/admin/brands/{brandId}/catalog-reviews/{reviewId}/decision` | `decideCatalogReview` | `catalog.approve` | brand (global reviewer grant must be explicit) | UNMAPPED; v1.5 reviewer proposes `catalog.review`, not `catalog.approve` |
| 30 | POST `/admin/brands/{brandId}/inventory/adjustments/{adjustmentId}/decision` | `decideStockAdjustment` | `inventory.adjust.approve` | brand (global approver grant must be explicit) | Inventory approver (proposed); operation-level permission mapping still required |
| 31 | GET `/brands/{brandId}/categories/{categoryId}/schema-versions/{version}` | `getCategorySchemaVersion` | `catalog.read` | brand | Brand catalog reader (proposed); exact W1 role/grant UNMAPPED |
| 32 | POST `/brands/{brandId}/media/{mediaId}/complete` | `completeMediaUpload` | `catalog.write` | brand | UNMAPPED; candidate uses catalog permission for media completion; confirm this contract |
| 33 | GET `/brands/{brandId}/media/{mediaId}` | `getMediaAssetStatus` | `catalog.read` | brand | UNMAPPED; candidate uses catalog permission for media status; confirm this contract |
| 34 | POST `/brands/{brandId}/products/{productId}/media` | `attachProductMedia` | `catalog.write` | brand | UNMAPPED; candidate uses catalog permission for media attach; confirm this contract |
| 35 | PATCH `/brands/{brandId}/products/{productId}/media/{linkId}` | `updateProductMediaLink` | `catalog.write` | brand | UNMAPPED; candidate uses catalog permission for media update; confirm this contract |
| 36 | DELETE `/brands/{brandId}/products/{productId}/media/{linkId}` | `detachProductMedia` | `catalog.write` | brand | UNMAPPED; candidate uses catalog permission for media removal; confirm this contract |
| 37 | POST `/admin/brands/{brandId}/variant-prices/{priceId}/decision` | `decideVariantPrice` | `pricing.approve` | brand (global approver grant must be explicit) | Independent pricing checker (proposed); exact W1 role/grant UNMAPPED |
| 38 | POST `/admin/catalog/categories/{categoryId}/schema-versions` | `proposeCategorySchemaVersion` | `taxonomy.manage` | platform-global-admin | Taxonomy administrator (proposed); must use separate global guard, no brand-derived authority |
| 39 | POST `/admin/catalog/categories/{categoryId}/schema-versions/{version}/publish` | `publishCategorySchemaVersion` | `taxonomy.approve` | platform-global-admin | Taxonomy administrator (proposed); separate approval permission and global guard |
| 40 | PATCH `/brands/{brandId}/products/{productId}/variants/{variantId}` | `updateProductVariant` | `catalog.write` | brand | Brand catalog editor (proposed); exact W1 role/grant UNMAPPED |
| 41 | DELETE `/brands/{brandId}/products/{productId}/variants/{variantId}` | `deactivateProductVariant` | `catalog.write` | brand | Brand catalog editor (proposed); exact W1 role/grant UNMAPPED |
| 42 | POST `/brands/{brandId}/products/{productId}/claims` | `proposeProductClaim` | `catalog.write` | brand | Brand catalog editor (proposed); exact W1 role/grant UNMAPPED |
| 43 | GET `/brands/{brandId}/products/{productId}/claims` | `listProductClaims` | `catalog.read` | brand | Brand catalog reader (proposed); exact W1 role/grant UNMAPPED |
| 44 | POST `/admin/brands/{brandId}/claims/{claimId}/decision` | `decideProductClaim` | `catalog.review` | brand (global reviewer grant must be explicit) | Platform reviewer (proposed); exact W1 role/grant UNMAPPED |

## Security findings and contracts to carry forward

1. **No W2 runtime access can currently be granted.** The W1 role catalog contains no candidate W2 permissions. Do not enable candidate endpoints until a reviewed role-to-permission migration and assignment policy exist.
2. **The v1.5 matrix is not a complete mapping for the 44 API permissions.** The matrix above records operation-level names without silently equating them to broader role labels. In particular, `catalog.approve` differs from the proposed `catalog.review`; `pricing.read`, media/import permissions, catalog workflow permissions, and several inventory permissions lack a proposed role mapping. `inventory.write`/`inventory.approve` are role labels, not the API codes `inventory.submit`, `inventory.adjust.propose`, or `inventory.adjust.approve`.
3. **Admin route naming is not authorization.** Brand-targeted review/approval operations must validate a separately granted reviewer permission for the target brand through the brand guard and scoped SQL. Taxonomy operations have no `brandId` and require a distinct platform-global guard. A brand owner or brand role cannot acquire taxonomy authority.
4. **Errors and nested resources:** prove foreign-brand detail/list/count/export/bulk/nested IDs disclose no data and are indistinguishable from absent resources. Do not reveal whether an import batch, media object, claim, adjustment, or review exists in another brand.
5. **Revocation:** after a committed grant expiry/revocation, membership suspension/revocation, or brand ineligibility, the next SQL statement using an old context must return no protected rows/change no rows.
6. **Mutation protections:** cookie-backed mutations need CSRF verification; privileged decisions need a reviewed mapping to the existing MFA guard/action vocabulary (or an explicitly approved extension), recent persisted step-up, and audit evidence. The W2 permission alone does not prove CSRF/MFA was enforced.
7. **Workers:** never use event payload `brandId`, user ID, role, or permission as authorization. Resolve the authoritative target/job entitlement in the service, bind a trusted allowlisted worker principal, scope each SQL statement, dedupe effects, and record immutable audit. These contracts remain unimplemented here.

## Verification crosswalk

These are existing W1 controls/evidence, not proof that W2 routes exist. W2 endpoint-specific acceptance scenarios remain **specifications only / NOT EXECUTED** until the owning W2 modules exist.

| Required scenario | Existing evidence / deferred W2 test specification |
|---|---|
| Cross-brand get/list/export/update, nested alias and count denial | `tests/brand-access.integration.test.cjs` verifies synthetic scoped SQL query shapes. W2 must repeat against real product, variant, media, import, inventory, review and export repositories; expected foreign rows/counts absent and writes unchanged. |
| Revoked permission denied on next statement | Same W1 integration suite covers stale context after committed access change. W2 must exercise real handlers/repositories after membership/assignment revocation. |
| Platform taxonomy write denied to brand role | `tests/platform-permission-guard.test.cjs` denies a brand principal with forged global claims; `tests/brand-access.integration.test.cjs` verifies with PostgreSQL that a brand-scoped grant cannot satisfy the platform guard and that current global W1 permissions pass the global lane. No W2 taxonomy handler exists yet; wire `taxonomy.manage`/`taxonomy.approve` to this guard when those routes are implemented. |
| Each API maps to known permission | Matrix above maps all 44 candidate operation IDs. `tests/ren2-49-authorization-matrix.test.cjs` checks all 44 rows have unique operation IDs, permission codes, a guard lane, and a role mapping or explicit deny/unmapped status. W1 has no W2 grants; route metadata/repository integration remains pending until W2 handlers exist. |
| Worker cannot forge human session or cross-brand target | No W2 worker principal exists. Add worker tests for forged event identity/brand, wrong-brand target, missing entitlement, duplicate delivery, scoped reads/writes, and immutable audit before worker activation. |
| Error non-disclosure, CSRF, MFA | W1 guard returns generic denial; session CSRF and MFA guards exist but are not automatically applied to future routes. W2 HTTP tests must verify foreign/missing parity, CSRF rejection, privileged MFA denial/allow audit, and no sensitive identifiers in responses/logs. |

Relevant checks: `tests/brand-access-guard.test.cjs`, `tests/platform-permission-guard.test.cjs`, `tests/brand-access-global-permission.test.cjs`, `tests/ren2-49-authorization-matrix.test.cjs`, `tests/brand-access-schema.integration.cjs`, `tests/brand-access.integration.test.cjs`, and `tests/mfa-guard.test.cjs`. Database integration suites run only against loopback disposable PostgreSQL `renivet_ci` per `tests/README.md`. REN2-49 adds no schema change or migration.

## Sources

- Engineering OS `docs/02-system-design/w2-catalog-inventory/v1.5/RENIVET_W2_Master_Specification_v1_5_CONSOLIDATED.md` (authorization and worker controls in §A5/A6).
- Engineering OS `docs/02-system-design/w2-catalog-inventory/v1.5/W2_OpenAPI_v1_5_CANDIDATE.yaml` (44 candidate operations; design contract, not a live API).
- Engineering OS W2 v1.5 SOPs, ERD, QA Closure Matrix, Acceptance Test Cases, Static QA Checks, Activation Gates, and merged W2 tabular execution plan dated 2026-11-03.
- Backend `docs/superpowers/specs/2026-10-31-ren2-26-brand-access-schema-design.md`, `docs/superpowers/specs/2026-10-31-ren2-27-brand-access-design.md`, `tests/README.md`, and the current source/tests named above.
