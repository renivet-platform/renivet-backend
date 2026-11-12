# REN2-22 Email OTP Delivery Implementation Plan

> **For agentic workers:** Execute this plan natively, one task at a time. Tests use an injected mail transport; CI must not send email.

**Goal:** Deliver email verification and password-recovery OTPs over configurable SMTP while preserving Renivet's challenge and privacy controls.

**Architecture:** Keep `OtpChallengeService` authoritative for OTP creation, expiry, rate limits, and one-use verification. Add an SMTP-backed email adapter behind `OtpDeliveryPort`, compose it with Fast2SMS by channel/purpose, and keep delivery disabled when configuration is incomplete.

**Tech Stack:** NestJS, TypeScript, Nodemailer, Node test runner, fake transport.

**Spec:** Linear REN2-22 and REN2-23 acceptance criteria; Engineering OS ADR-W1-001 and W1 SRS.

## Global Constraints

- Never log OTPs, destination addresses, SMTP credentials, message bodies, or raw provider errors.
- Do not change public OTP contracts, challenge persistence, authorization, or recovery semantics.
- No network I/O in unit/CI tests; no real credentials in source or test fixtures.
- SMTP delivery is unavailable unless host, port, sender, and required authentication are valid.

## Review Focus

- Partial or malformed SMTP config never starts a network connection.
- `password_recovery` is sent only to email and uses the same one-use challenge lifecycle.
- Timeout/rejection errors remain generic and do not leak recipient, code, or credentials.
- Non-ASCII content and code interpolation remain safe plain text/HTML.
- Phone messages continue through Fast2SMS without behavior change.

---

### Task 1: Email SMTP adapter

**Files:** `src/modules/identity/smtp-otp-delivery.ts`, `tests/smtp-otp-delivery.test.cjs`, package manifest/lock, environment config and `.env.example`.

- [ ] Add failing tests for complete/partial config, supported email purposes, rendered message, timeout, transport rejection, and no secret leakage.
- [ ] Implement injectable SMTP transport and safe configuration parsing.
- [ ] Run focused tests and full backend verification.

### Task 2: Application wiring and operational notes

**Files:** `src/modules/identity/identity.module.ts`, `src/config/*`, identity README.

- [ ] Wire email adapter for email purposes and Fast2SMS for phone verification.
- [ ] Document SMTP environment keys and manual test steps without credentials.
- [ ] Review diff, commit, push feature branch, open PR, and stop for owner review.
