# REN2-22 Purpose-Bound OTP Challenges

## Intent

Implement the W1 OTP challenge lifecycle for email and phone verification. The feature must issue six-digit codes, bind each challenge to one user, channel, purpose, and expiry, reject expired/wrong/replayed codes, throttle abusive attempts, and avoid live delivery providers in development and CI.

## Goals

- Use PostgreSQL `identity.auth_challenges` as the durable lifecycle authority; do not add a parallel challenge table.
- Store only an HMAC-SHA-256 digest of each code in PostgreSQL. Keep the raw code transient in the delivery adapter and never log or persist it.
- Enforce the owner-accepted starting defaults from ADR-W1-001: six digits, 300-second expiry, five failed attempts, 60-second resend cooldown, and three resends per destination/purpose per 900 seconds; keep these values configurable.
- Use Redis for per-IP and per-destination/purpose throttles and short-lived distributed locks; retain PostgreSQL row/advisory locking as the correctness authority for concurrent issue/consume operations.
- Provide a fake delivery adapter for tests and an unavailable adapter as the application default. Do not add Twilio, WhatsApp, SMS, or email credentials or make external calls.
- Document only implemented routes in NestJS-generated OpenAPI and the version-controlled Postman collection.

## Non-goals

- Real email/SMS/WhatsApp provider integration, sender registration, templates, consent/legal review, or production delivery.
- Password recovery, OTP login/session issuance, privileged MFA, session lifecycle, or identity linking; those belong to later approved slices.
- Redis as the canonical challenge store or storage of plaintext codes in Redis, PostgreSQL, logs, events, Postman examples, or CI artifacts.
- Shared or production migrations, deployments, Postman Cloud synchronization, or changing Linear status.

## Contract and source boundary

REN2-22's current Linear brief requires PostgreSQL challenge authority, fake adapters first, and OpenAPI/Postman artifacts for actual HTTP routes. The Engineering OS lists `POST /api/v1/auth/challenges` and `POST /api/v1/auth/challenges/{challengeId}/verify` as candidates and explicitly says they are not established D04 contracts. This feature implements those two narrow routes as a reviewable proposal, with DTOs described in generated OpenAPI and a Draft PR gate for the owner to approve the route/DTO contract. No additional route is introduced.

The existing `identity.auth_challenges` columns (`user_id`, `kind`, `code_hash`, `expires_at`, `attempt_count`, `consumed_at`) support the lifecycle. `kind` stores the channel-purpose pair; the challenge ID, user ID, channel, purpose, current canonical contact, and code are included in the HMAC input. No DDL change is planned unless testing proves an existing constraint is insufficient.

## Behavior

- Issue accepts `channel`, matching `purpose`, and a destination. Email is normalized with the REN2-21 canonical rule; phone must be E.164. Unknown or already-verified contacts receive a neutral accepted response and do not cause a delivery.
- For an eligible unverified identity, rate limits and the destination-purpose lock are acquired before database mutation. A transaction serializes the identity/purpose, consumes any prior active challenge, and inserts the new digest/expiry/attempt row. Delivery happens through the injected adapter; a transient delivery failure consumes the just-created challenge and returns the same neutral accepted response shape as an unknown contact, preventing provider behavior from becoming an account-existence oracle. The globally unavailable default adapter rejects uniformly before identity lookup.
- Verify receives an opaque challenge ID, code, and expected purpose. Redis/IP throttles and a challenge lock run before a PostgreSQL transaction locks the challenge and user rows. Wrong purpose, wrong code, expiry, exhaustion, and reuse return one generic denial. Failed codes increment durable `attempt_count`; the fifth failure consumes the challenge. A valid code is atomically consumed and marks only the bound email or phone verified. Concurrent verification can succeed at most once.
- PostgreSQL is authoritative for challenge state. Redis outages fail closed before issue or verification mutates PostgreSQL. Raw contact/code values do not appear in public errors or application logs.

## Approaches considered

- Redis-only challenge storage: rejected because ADR-W1-001 makes PostgreSQL canonical and Redis loss must not erase lifecycle authority.
- PostgreSQL-only throttling: rejected because the approved defaults assign ephemeral IP/destination limits and cooldowns to Redis.
- PostgreSQL authority with Redis throttles/locks and fake-only provider boundary: selected because it matches ADR-W1-001 and the current REN2-22 scope while permitting deterministic disposable integration tests.

## Constraints and review points

- No schema/migration edits unless required by existing table constraints; any migration applies only to disposable CI/test databases.
- No real provider, live credential, staging/production database, or Postman Cloud side effect.
- Keep PR Draft until owner approval of the proposed D04 route/DTO contract; never merge or change Linear status without owner action.
- Review focus: concurrent send/verify races, contact changes between issue and verification, expiry boundary, attempt exhaustion, purpose/channel mismatch, Redis/provider outage, enumeration-safe responses, and secret/log redaction.
