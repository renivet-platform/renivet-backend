# PostgreSQL Drizzle boundary

Drizzle migrations are version controlled under `drizzle/`. NestJS startup never pushes schema changes automatically. Apply migrations only to an explicitly selected disposable or authorized database.

## REN2-20 identity slice

The first W1 migration adds the four canonical D02 identity tables: `identity.users`, `identity.user_credentials`, `identity.user_sessions` and `identity.auth_challenges`. It preserves the ERD's schema-qualified names and base fields; it does not add a second `accounts` or `auth_sessions` model or any HTTP endpoints.

Physical decisions in this slice:

- Email is stored trimmed and lowercase. A unique index on `lower(btrim(email))` enforces normalized ownership; phone is stored in E.164 form and uniquely indexed. These constraints apply independent of account state, so suspension or deactivation does not release an identifier for takeover.
- `users.state` remains non-empty text because the source does not define an exhaustive status vocabulary. Verification timestamps require their corresponding contact.
- Password hashes must be Argon2id PHC strings. Each user can have one active password credential; `(user_id, credential_version)` is unique so disabled credential history can be retained.
- Session-token hashes use lowercase 64-character SHA-256 hex digests. Challenge-code hashes use the same encoding for HMAC-SHA-256 digests, so low-entropy OTPs are not stored as plain SHA-256 hashes. The application layer must supply the cryptographic digests and protect any HMAC key.
- Expiry, attempt-count, ownership and row-version constraints are enforced in PostgreSQL. Foreign keys do not cascade deletes; retention and deletion flows need an explicit policy before implementation.

The schema and SQL migration are proposals for the REN2-20 feature PR and require review. Disposable PostgreSQL 16 integration checks verify the actual migration, exact identity index definitions, uniqueness under concurrent writes, foreign keys, lifecycle checks and secret-hash formats. A separate CI recovery rehearsal rebuilds the disposable database from a PostgreSQL template snapshot, then reruns migration and integration checks. This validates the recovery path in CI; it is not a production backup/restore rehearsal. No shared database or deployed environment is changed by these tests.

## REN2-29 outbox, inbox and durable work state

The next W1 migration adds schema-qualified `platform.outbox_events`, `platform.webhook_inbox`, `platform.inbox_receipts`, `platform.durable_jobs` and `platform.dead_letter_cases`. Outbox event keys are unique within an aggregate; pending outbox and scheduled-job partial indexes support bounded claims. The job table carries lease owner/start/expiry, bounded attempts (the ADR's initial maximum is five), and a safe error code. Lease duration is capped at five minutes. Runtime claiming, retry scheduling, worker processes and provider integrations are outside this schema issue.

`webhook_inbox` records external provider event identifiers and only a payload hash plus optional protected payload reference. It does not persist raw provider bodies or credentials. `inbox_receipts` is the separate internal consumer/message deduplication record, unique per consumer and outbox message. Consumer effects and their receipt must be written in the same application transaction. Outbox payloads are JSONB and producers must keep them to allow-listed business data; secrets and authentication/session data are prohibited.

`durable_jobs` and `dead_letter_cases` extend the reviewed D02 platform ERD to provide the claim, bounded lease, attempt and error/recovery metadata required by REN2-29. Internal receipts are the minimal extension needed to make per-consumer idempotency explicit. These are schema proposals until reviewed and merged. The disposable PostgreSQL 16 integration test verifies the migration's actual objects, constraints, deduplication and transaction behavior; CI repeats it after the disposable snapshot recovery rehearsal.

REN2-30 adds `platform.dead_letter_recovery_audit`, an append-only record of recovery case, operator identity, approved reason code and timestamp. The `DurableWorker` code claims and processes only registered event types, applies the receipt and internal effect in one transaction, and uses safe failure codes with capped exponential retry. Recovery fails closed without an injected authorization policy. The worker is not registered or scheduled by default, and callers must connect authorization to the approved operator permission system before making recovery accessible. CI exercises concurrency, retry, replay, lease recovery, secret redaction and audited recovery on disposable PostgreSQL 16.

### Tenant, privacy and recovery boundaries

These are platform-level tables with no `tenant_id` column or row-level security policy. `aggregate_type` and `aggregate_id` identify an owning business record; they are not authorization checks. A future consumer must resolve tenant/brand scope from that authoritative record and enforce it in the same transaction as its domain effect. It must not trust tenant scope supplied only inside `event_payload`. This describes the current schema boundary; owner/security approval of any cross-tenant worker access policy remains outstanding.

`webhook_inbox` stores a payload hash and optional payload reference, not a raw provider body. `outbox_events.event_payload` is unrestricted JSONB at the database level, so the schema cannot prevent a producer from including personal or secret values. Producers must use typed, allow-listed event DTOs and tests; do not include OTPs, session tokens, password hashes, bank details, or unnecessary personal data. No retention or deletion period is defined for outbox, webhook inbox, consumer receipts, durable jobs, or dead-letter records. Cleanup must preserve the replay/idempotency and audit windows and requires an approved retention policy before production use.

The migration is additive and has no checked-in down migration. PostgreSQL 16 CI verifies forward application, replay, and restoration of the migrated schema plus a synthetic outbox row from a disposable snapshot. This does not prove production backup recovery or provide a rollback plan; those remain deployment/release decisions, and this feature branch has not run against a shared database.

## REN2-26 brand membership, roles, and access audit

Migration `0005_ren2_26_brand_membership_permissions_audit.sql` implements the W1-B1 persistence slice from REN2-26. Its logical source is `RENIVET_Complete_ERD_Import_Package_2026-10-22.zip`, verified against the Engineering OS source register at 334,148 bytes and SHA-256 `d8422b1080da7ffa4d880cba2f1fa3ea0000d6191bfb60fd18d15bb57100e119`. The archive is referenced by fingerprint here; this backend PR does not import or change the Engineering OS source register.

The migration creates the canonical `brands.brands` root (not previously present in the backend migration chain), `brands.brand_memberships`, and `access.roles`, `access.permissions`, `access.role_permissions`, `access.role_assignments`, and `access.security_audit_events`. Role assignments reference the authenticated principal, a role whose scope matches `scope_type`, and for brand roles the same principal's membership in that brand. Membership and role assignment validity windows, role scope, memberships, and permission links are database constrained. No user is assigned a role by migration.

The seeded first-slice matrix is intentionally narrow:

| Role | Scope | Permissions |
| --- | --- | --- |
| `renivet_admin` | Global | `staff_access.manage`, `brand_membership.review`, `brand_membership.manage`, `access_audit.read` |
| `renivet_support` | Global | `account_status.read`, `brand_status.read` |
| `brand_owner` | One brand | `brand_membership.read`, `brand_membership.invite`, `brand_membership.revoke`, `brand_role.assign_staff`, `brand_access_audit.read` |
| `brand_staff` | One brand | `brand_membership.read_self` |

These permissions cover access administration only. They do not imply access to product, order, payment, or finance operations. Brand Owners cannot assign global roles or promote another member to owner. Sensitive membership/role mutations require the existing privileged-MFA guard when runtime handlers are implemented. All other permissions default deny.

`access.security_audit_events` follows the ERD's append-only privileged-event shape and a PostgreSQL trigger rejects updates and deletes. Access audit rows have no cleanup job and are retained permanently per the owner decision. Actor foreign keys do not cascade deletion; hard deletion of an identity that is referenced by an access event is blocked so the actor reference remains intact. Store only allow-listed event metadata as its SHA-256 payload hash, never raw secrets or unnecessary personal data. Application-level audit writes and authorization checks are not implemented by this schema story.

`access.effective_permissions` is a read-only, database-side resolver. It returns only active user grants within their validity windows; brand-scoped grants additionally require an active, joined, unexpired membership and an approved brand. Global staff grants remain explicitly global (`brand_id IS NULL`). A runtime authorization handler must query this relation for the authenticated user and the selected brand, and every business repository must still constrain reads/writes by the authorized brand ID (REN2-27/28).

Regranting a role reopens its durable assignment row after appending the appropriate immutable audit event; role assignment uniqueness is intentionally durable per user, role, and scope. Historical grant and revocation actions belong in `access.security_audit_events`, not duplicate live assignment rows. Sensitive-action MFA and actor/approval policy will be enforced by runtime handlers.

`tests/brand-access-schema.integration.cjs` verifies actual PostgreSQL 16 tables, indexes, seeds, FKs, status/scope/window constraints, duplicate grants, scope-to-membership binding, zero preassigned users, effective-permission denial for inactive/future/expired assignments, suspended/pending/expired membership and unapproved brands, durable regrant behavior, and audit immutability. CI runs it after migration and after its disposable recovery snapshot. Cross-tenant business-resource repository predicates and MFA enforcement at sensitive routes are subsequent REN2-27/28 work. The migration is additive; no shared, staging, or production database was changed.
