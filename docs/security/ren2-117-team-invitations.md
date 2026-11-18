# REN2-117 · Verified Brand Team Invitations

New endpoints (all cookie/session-bound and mutation CSRF-bound):
- `GET /brands/:brandId/access/team-v2` — authorized member roster (actual names/email where provided), role summaries and pending delivered invites, no internal permission dump.
- `POST /brands/:brandId/access/invitations` — email invite limited to catalogue editor/stock manager, seven-day expiry; delivery failure is not reported as success.
- `POST /brands/:brandId/access/invitations/:invitationId/cancel` — owner cancels outstanding invite.
- `POST /brands/:brandId/access/invitations/accept` — user logged in via same verified email accepts invitation, receives only the invited role.
- `POST /brands/:brandId/access/team/:userId/revoke` — immediately revokes nonowner access and active role assignments. Historical audit remains immutable.

## Invariants
No owner promotion or owner revocation through staff endpoint; no unverified user acceptance; no role created from a UI string; no permission read without brand scope; old W1 access endpoint remains compatible. SMTP or Resend must be configured for email delivery. Migration 0046 creates invitation table and two brand-scoped preset roles. Run migration only after review in a controlled environment, not automatically in shared production.

## QA
Unit/integration tests still need actual database and SMTP/Resend test provider with two brands and owner/staff/unauthorized identities. OpenAPI/SDK regeneration and complete browser E2E must be validated before merge/deploy. No production configuration was changed.
