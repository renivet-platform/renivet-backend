# Identity authentication foundation

This module implements REN2-21 registration/password authentication, REN2-22 email/phone verification challenges, REN2-23 opaque sessions/CSRF-protected logout/email password recovery, and REN2-24 privileged MFA enrollment, step-up, revocation and security audit. NestJS DTO/decorator metadata is authoritative for the generated OpenAPI contract. Handwritten Postman functional collections are version controlled under `postman/collections/` and run against disposable CI services.

## Public operations

- `POST /api/v1/auth/register` creates a pending-verification email account and returns the same `202` body for new and duplicate canonical addresses.
- `POST /api/v1/auth/sessions` accepts an active, email-verified account's password and issues a 30-minute opaque first-party session cookie.
- `POST /api/v1/auth/challenges` with `channel: phone` and `purpose: phone_login`, followed by purpose-matched verification, signs in an active account with an already verified phone. The OTP is consumed atomically with session creation; the raw session token is returned only in the secure HttpOnly cookie.
- `GET /api/v1/auth/session` validates the opaque cookie, renews its 30-minute idle expiry up to a seven-day absolute maximum, and returns a minimal identity plus session-bound CSRF proof.
- `DELETE /api/v1/auth/session` requires the active cookie, an exact configured `Origin`, `Sec-Fetch-Site: same-origin`, and matching `X-CSRF-Token`; it revokes the database session before expiring the cookie.
- `POST /api/v1/auth/phone` requires the active session and same-origin CSRF proof. It attaches an India mobile number as unverified, preserves a matching already-verified number, and never starts an OTP delivery by itself.
- `POST /api/v1/auth/challenges` requests email or phone verification. Unknown and already-verified contacts receive a neutral accepted response without delivery.
- `POST /api/v1/auth/challenges` also accepts the email-only `password_recovery` purpose. Ineligible contacts receive a neutral accepted response.
- `POST /api/v1/auth/challenges/{challengeId}/verify` verifies and consumes a one-use proof. Verification marks only its bound contact; password recovery additionally validates and hashes a replacement password and atomically revokes all prior user sessions.
- `GET /api/v1/auth/mfa` reports `not_enrolled`, `enrollment_pending` or `enabled` plus the remaining recovery-code count, without exposing factor material.
- `POST /api/v1/auth/mfa/enrollments` starts a ten-minute TOTP enrollment and returns its `otpauth` URI once. `POST /api/v1/auth/mfa/enrollments/verify` validates the first code, activates the factor, rotates the opaque session and returns ten recovery codes once.
- `POST /api/v1/auth/mfa/step-up` accepts an unused TOTP time step or one unused recovery code, atomically consumes it, and rotates the session with a server-side MFA verification timestamp. `DELETE /api/v1/auth/mfa/factor` requires a step-up no older than 300 seconds, revokes all sessions, and wipes stored factor ciphertext.

## Credential and challenge controls

- Passwords are stored only as Argon2id PHC hashes (`m=19456 KiB`, `t=2`, `p=1`); unknown, wrong, unverified and inactive login identities share one generic failure.
- Session tokens are random 256-bit values returned only in a `__Host-renivet_session` cookie (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`). PostgreSQL stores only a SHA-256 digest.
- Session lookup and revocation use only the database digest. Login rotates a presented same-user session. Recovery changes the active password credential and revokes all sessions inside the same transaction as challenge consumption.
- Cookie-authenticated logout requires a CSRF proof derived with the dedicated `AUTH_CSRF_HMAC_KEY`, exact allowlisted Origin, and same-origin Fetch Metadata. `AUTH_ALLOWED_ORIGINS` must contain exact origins; staging/production require HTTPS origins and a dedicated key.
- OTPs are six-digit CSPRNG values with the approved initial defaults: five-minute expiry, five failed attempts, a 60-second resend cooldown, and three resends per contact/purpose in 15 minutes. Bounded environment settings configure lifecycle limits.
- PostgreSQL `identity.auth_challenges` is the durable authority. It stores only an HMAC-SHA-256 proof that binds challenge, user, channel, purpose, canonical contact, and code. Redis provides HMAC-keyed rate limits and short-lived operation locks; PostgreSQL transactions and row locks govern replacement, attempts, verification, and one-use consumption.
- Raw OTPs exist transiently only in the delivery adapter. Email verification and password recovery use the SMTP relay only when valid `SMTP_HOST`, `SMTP_FROM`, `SMTP_USERNAME`, and `SMTP_PASSWORD` values are configured. Phone verification uses Fast2SMS DLT only when all four server-side `FAST2SMS_*` values are valid. Missing or partial provider configuration performs no network I/O. CI and integration tests use fake transports and never contact a real provider.
- Limiter-store failures fail closed. Responses and exception handling omit contact, code, proof, password, and provider-error details; submitted credentials are not logged.
- TOTP uses RFC 6238 six-digit SHA-1 codes with a 30-second period and one adjacent step of clock tolerance. The accepted counter is stored to reject replay. Factor secrets use AES-256-GCM under a dedicated canonical base64 `AUTH_MFA_ENCRYPTION_KEY` (32 decoded bytes); recovery codes contain 128 random bits and only SHA-256 digests are stored. Never reuse HMAC keys as the encryption key.
- MFA enrollment, step-up, revocation and privileged-access allow/deny decisions write allowlisted audit events. Audit metadata excludes codes, recovery values, provisioning URIs, factor ciphertext, session tokens and IP addresses; IP is represented by a keyed digest.

## Contract and scope boundaries

REN2-21/22/23 route/DTO contracts continue the proposed API candidate paths and remain subject to D04 owner approval; no production/deployed topology is asserted by disposable local tests. REN2-24 adds migration `drizzle/0002_ren2_24_privileged_mfa.sql`. `@RequireMfa()` is an exported server-side gate for sensitive brand, staff, finance-evidence and global-taxonomy operations; the taxonomy wrapper also requires a global W1 permission. Those domain routes and permission grants are not activated by the identity slice, so do not claim a currently existing commerce/admin action is protected until its route applies the appropriate guards. Freshness is currently five minutes. Product/security owners must review this default, the business permission matrix and recovery policy before production use. SMTP email delivery and Fast2SMS DLT phone delivery are enabled only when complete server-side configuration is supplied. Provider account setup, sender-domain verification, deliverability, and authorized live tests remain deployment-specific.

For integration tests, use only PostgreSQL 16 database `renivet_ci` and Redis database 15 on loopback, with `RENIVET_TEST_SERVICES_DISPOSABLE=1`. CI provides disposable services and runs the Postman collections. Local integration tests reject missing disposable markers or non-loopback targets.

## Fast2SMS DLT phone delivery (REN2-39)

Phone verification can use the Fast2SMS DLT SMS route after all four `FAST2SMS_*` values in `.env` are configured: API key, Fast2SMS Message ID, approved sender ID, and DLT entity ID. The adapter stays unavailable when any value is missing or malformed. Fast2SMS DLT Manager binds the Message ID, sender and entity; the API request sends the Message ID, sender ID, DLT route, recipient, and template variables over HTTPS POST.

The approved template has variables in this order: OTP, expiry in minutes. Renivet generates the six-digit code and remains authoritative for purpose binding, expiry, throttling, persistence and one-use verification. The provider receives the code transiently only to deliver the SMS. The adapter accepts only Indian `+91` mobile destinations and the `phone_verification` or `phone_login` purpose. Email uses the configurable SMTP adapter for email verification and password recovery. Provider errors, malformed responses and timeouts become a generic delivery failure; adapters do not log API keys, SMTP credentials, OTPs, phone numbers, email addresses, message bodies, or raw provider responses.

Automated tests inject a fake HTTP transport and never send real SMS. A real end-to-end test to a test phone requires the owner's explicit authorization.

Manual test procedure after that authorization:

1. Put `FAST2SMS_API_KEY`, `FAST2SMS_MESSAGE_ID`, `FAST2SMS_SENDER_ID`, and `FAST2SMS_DLT_ENTITY_ID` in the backend's local secret environment only, then restart the API. Do not copy these values into the frontend environment, Postman, CI, or source control.
2. Sign in to the customer app and open the account page. Enter the authorized Indian test mobile number and choose **Add phone and send code**.
3. Enter the code received on that phone and choose **Verify phone number**. Confirm the account page reports the contact as verified.
4. Confirm verification does not create a session or enable phone-number login. Do not paste the real number or OTP into tickets, logs, screenshots, or source control.

The manual delivery check is separate from CI. Automated tests use synthetic data and a fake provider response, so they cannot incur SMS charges or send messages.

## SMTP email delivery

Configure the authenticated SMTP relay on the backend only. Set `SMTP_HOST`, `SMTP_FROM`, `SMTP_USERNAME`, and `SMTP_PASSWORD`. `SMTP_PORT` defaults to 587; implicit TLS defaults on for port 465, and STARTTLS is required otherwise. `SMTP_SECURE` can explicitly select the provider's supported mode. Incomplete configuration keeps email delivery unavailable and does not open a connection.

The adapter sends plain-text and HTML one-time-code email for `email_verification` and `password_recovery`. Subjects contain neither the address nor code. SMTP operations are bounded and require TLS 1.2 or newer; provider errors are mapped to a generic failure. CI tests inject a fake transport and never send email. Before a live test, verify the sender domain and provider policy, configure backend secrets, and use an authorized test mailbox. Never put SMTP credentials, real OTPs, or personal addresses in source, CI logs, browser storage, or documentation examples.
