# REN2-73 — Catalog publication lifecycle

`CatalogPublicationService` and `CatalogPublicationPostgresRepository` provide internal commands to publish, restrict, and unpublish a product. REN2-73 adds no HTTP route and does not turn a proposed OpenAPI operation into an active API.

## Publish

Publishing requires the exact product revision and QC decision IDs. The transaction locks the product and approved records, checks the expected row version, confirms the review is approved by someone other than the submitter, verifies the immutable snapshot hash, and rechecks its active leaf category, published schema, current approved prices, attached clean media and derivatives, rights, and revision-bound verified claims with accepted unexpired evidence. It then changes the publication pointers and version, appends the immutable lifecycle event, writes the matching W1 outbox event, and stores an immutable idempotency receipt in the same transaction.

## Restrict and unpublish

Restriction and unpublishing retain the exact published revision and approval references. They record a reason, optional comment, and optional appeal reference. Unpublish is allowed from either `PUBLISHED` or `RESTRICTED`. Every lifecycle transition increments the publication and product row versions and emits its own append-only event and W1 outbox record. The product row lock and expected-version check prevent a stale publish request from overriding a completed restriction.

## Authorization and activation

The commands require effective W1 `catalog.publish` or `catalog.restrict` permission at global or matching brand scope. The migration registers these permission codes but assigns neither permission to any role. They must be granted by the project owner through W1 policy. Commands remain internal until the approved route/permission mapping and runtime gates G09, G14, and G17 are evidenced. No route, W3 integration, or production-readiness claim is included in REN2-73.

The database migration also guards event state against the current product pointers, approved QC record, permission, matching outbox payload, event key, and command receipt. The deferred constraint rejects a versioned transition if the complete event/outbox/receipt set is absent, so a failed command rolls back without a partial publication event.
