# REN2-23 secure sessions, CSRF and recovery

## Goal
Complete the session lifecycle and recovery behavior required by REN2-23 using the existing `identity.user_sessions` and `identity.auth_challenges` authority.

## Approved design constraints
- Opaque 256-bit session secret; persist only SHA-256 digest.
- Customer inactivity lifetime is 30 minutes, capped by a 7-day absolute lifetime measured from session creation.
- Cookie remains host-only `__Host-renivet_session; Path=/; Secure; HttpOnly; SameSite=Lax`.
- Cookie-authenticated mutation requires a per-session HMAC-derived CSRF token in `X-CSRF-Token` and an exact configured Origin match. Protected environments require explicit HTTPS origins.
- Login invalidates any prior presented session before issuing a fresh secret. Logout and password recovery revoke database sessions.
- Recovery reuses the existing challenge endpoints with the distinct `password_recovery` purpose. Only verified email identities are eligible. Recovery responses are neutral, proof is purpose-bound and one-use, new credentials are validated and Argon2id hashed, and all prior sessions are revoked transactionally.
- Recovery delivery remains unavailable until an approved provider is configured. Tests inject synthetic delivery only; no provider credentials or live delivery are used.
- OpenAPI is generated from NestJS decorators; Postman functional tests remain handwritten and version controlled.

## Topology
The service validates configured allowed origins and requires same-origin request evidence for cookie-authenticated mutations. HTTPS is enforced for configured staging/production origins. The existing cookie is secure in every environment. This implementation does not claim that an external production reverse proxy or deployed origin has been exercised.

## Scope
Implement candidate `GET /auth/session` and `DELETE /auth/session`, strengthen `POST /auth/sessions`, extend challenge purpose handling for password recovery, add tests, OpenAPI and Postman artifacts, and document operational limits.

## Explicit non-goals
No JWT, localStorage authority, administrator/MFA session policy, new database table, live provider, shared database change, deployment, or Postman Cloud synchronization.
