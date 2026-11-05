# REN2-72 catalog QC review boundary

`CatalogReviewService` and `CatalogReviewPostgresRepository` implement the internal review command for one exact immutable submitted revision. The service is registered as a catalog provider for later orchestration; REN2-72 does not expose an HTTP endpoint.

The candidate `decideCatalogReview` operation proposes a path parameter named `reviewId`, but the existing system has no review-queue resource to identify before a decision. The implemented internal command instead receives `productId` plus the required `expectedRevisionId`, reason, decision and expected product row version. It rejects a revision that does not belong to that exact product and brand. Reconcile the queue identifier and public request mapping before adding a route.

The repository requires a current global W1 `catalog.review` effective permission and an approved brand. Brand-scoped review grants do not authorize platform QC. The reviewer must differ from `product_revisions.submitted_by`. REN2-69 introduced the permission; this migration does not grant it to any role. A future HTTP adapter must add the approved route, session-bound CSRF and recent MFA checks after G01/G17 evidence and permission mapping are approved.

Before deciding, the transaction verifies the submitted snapshot hash and checks that every pinned active variant price is still approved and effective, each selected media link remains attached with clean derivatives and reviewed rights, and each included claim plus at least one evidence asset remains verified and eligible. Product and revision rows are locked and the expected product row version is checked. A unique decision per revision and the transaction prevent conflicting outcomes. The immutable review, immutable audit event, product/revision transitions and immutable idempotency receipt commit together.

Internal error codes map to the following transport categories when a future adapter is added:

| Code | Status | Meaning |
|---|---:|---|
| `CATALOG_REVIEW_REQUEST_INVALID` | 422 | Invalid decision, reason, revision ID, comment or row version |
| `CATALOG_REVIEW_NOT_FOUND` | 404 | Product/revision is absent or inaccessible |
| `CATALOG_REVIEW_ACCESS_DENIED`, `CATALOG_REVIEW_MAKER_CHECKER_CONFLICT` | 403 | No global checker permission or submitter self-review |
| `CATALOG_REVIEW_VERSION_CONFLICT`, `CATALOG_REVIEW_STATE_CONFLICT`, `CATALOG_REVIEW_ALREADY_DECIDED`, `CATALOG_REVIEW_IDEMPOTENCY_CONFLICT` | 409 | Stale state, competing outcome, or changed replay payload |
| `CATALOG_REVIEW_EVIDENCE_INVALID`, `CATALOG_REVIEW_MEDIA_INVALID`, `CATALOG_REVIEW_PRICE_INVALID` | 422 | Submitted proof, media, or pinned price is no longer eligible |
| `CATALOG_REVIEW_DATABASE_UNAVAILABLE` | 503 | Review storage cannot accept the command |

Approval moves QC to `APPROVED`; it does not publish a listing. Actual publication, restriction propagation, public reads and W1 outbox delivery remain REN2-73/release-gated work. No W3 behavior is claimed.

A `RESTRICTED` decision on an un-published revision leaves `qc_state=RESTRICTED` and moves the mutable product to `RE_REVIEW`. That keeps the listing unavailable while allowing an authorized content correction and a new submission; publication restriction remains a separate REN2-73 lifecycle action.
