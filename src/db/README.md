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
