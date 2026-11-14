# REN2-55 — W1 brand approval to catalog eligibility

The identity module exports an **internal-only** `BrandCatalogEligibilityService` port for the established W1 brand application review flow. This work adds no HTTP route and no second application/review workflow. The W1 caller must invoke the port only after its existing session-bound CSRF, recent MFA and independent checker controls have accepted the review outcome.

The persistence adapter independently rechecks both recorded reviewers against the live, global W1 `renivet_admin` grant for `brand_membership.review` in the same transaction that changes state. The applicant cannot act as either reviewer, and the approver and checker must be different users. Client-supplied role claims are not accepted.

Approval is accepted only for a `pending` brand and its existing `pending` or already `active` applicant membership. A pending membership becomes active and receives `joined_at`; an existing role assignment is required for any effective W1 permission and is not created, copied or changed by this handoff. W1 `access.effective_permissions` continues to require an active joined membership and an approved brand. Rejection records the outcome and moves only a pending brand to `rejected`. Suspended/restricted/archived or otherwise non-reviewable states fail closed; this event cannot reinstate them.

The source event UUID is the idempotency key. Exact replay returns the original result; reuse with different payload conflicts. Brand state, membership activation and immutable event/audit receipt commit atomically. Audit rows cannot be updated or deleted. No stock location or inventory balance is created; the existing explicit I1 handoff remains in force.

No role grant, account, membership or brand data is seeded by this change. PostgreSQL integration evidence belongs exclusively to the disposable CI database; apply the migration to an existing environment only through its separately approved rollout process.
