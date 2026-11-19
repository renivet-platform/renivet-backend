# REN2-117 — Brand Import History

Adds `GET /api/v1/brands/:brandId/product-imports?limit=25&cursor=<batch UUID>` using existing `imports.import_batches`, `imports.import_uploads`, and `imports.import_rows` (no new migration). Brand permissions are checked by `BrandAccessGuard` with `imports.write`, and the SQL always binds the validated active brand ID. Returns file name, source, job state, export timestamp, creation/update timestamps and row count, with cursor pagination.

This supports the approved SE-12 Imports list in frontend PR #78. Existing import creation, signed uploads, mapping/preview/confirm/retry are untouched. Unit/DB integration, cross-brand denial, API generation, contract regression and real frontend verification are required before merge. Do not expose private import file data or media to a different brand. No production deployment performed.
