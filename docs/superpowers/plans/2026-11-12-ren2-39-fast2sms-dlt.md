# REN2-39 Fast2SMS DLT Adapter Implementation Plan

> **For agentic workers:** Follow the repository's one-issue/one-branch workflow. Implement the steps in order and test each behavior.

**Goal:** Deliver Renivet phone-verification OTPs through the configured Fast2SMS DLT SMS route.

**Architecture:** Preserve `OtpChallengeService` as the source of OTP generation and verification. Add a bounded Fast2SMS adapter behind `OtpDeliveryPort`, activate it only when the complete DLT configuration is present, and keep email delivery unavailable.

**Tech Stack:** NestJS, TypeScript, Node fetch, Node's test runner, Fast2SMS DLT SMS API.

**Spec:** `docs/superpowers/specs/2026-11-12-ren2-39-fast2sms-dlt-design.md`; Linear REN2-39.

## Global Constraints
- Keep OTP generation, purpose binding, expiry, throttling, verification, and one-use consumption in Renivet.
- No real provider calls in automated tests or CI.
- Keep credentials server-side and never log secrets, OTPs, phone numbers, request bodies, or raw provider errors.
- Missing or partial provider config leaves delivery unavailable.
- Never merge or deploy; owner reviews and merges the PR.

## Review Focus
- Provider timeout/abort must not leave a valid OTP challenge.
- Provider rejection, malformed response, and network failure must be generic and bounded.
- Only phone verification may be routed to Fast2SMS; email delivery must not be sent as SMS.
- The template variable order and expiry rounding must match the approved DLT content.
- No test may make an internet call.

---

### Task 1: Fast2SMS Adapter

**Files:**
- Create: `src/modules/identity/fast2sms-otp-delivery.ts`
- Create: `tests/fast2sms-otp-delivery.test.cjs`
- Modify: `src/modules/identity/otp-delivery.ts`, `src/modules/identity/otp-challenge.service.ts`, `src/modules/identity/identity.module.ts`
- Modify: `.env.example`
- Modify: `src/modules/identity/README.md`

**Interfaces:**
- Consumes: `OtpDeliveryPort.send(message, signal)` and validated configuration.
- Produces: `Fast2SmsOtpDelivery` implementing `OtpDeliveryPort`; DLT request uses `route=dlt`, Fast2SMS `message` ID, configured sender ID, ten-digit Indian destination, and `variables_values` containing the Renivet OTP followed by expiry minutes.

- [x] Add failing unit tests for complete/incomplete config, valid DLT payload, timeout/abort, provider errors, malformed JSON/status, secret and PII redaction, and no-network transport injection.
- [x] Run focused tests through a red-green cycle, including purpose-specific routing.
- [x] Implement the minimal adapter and per-channel availability routing.
- [x] Run focused tests and all repository-required checks.
- [ ] Review the complete diff, stage only REN2-39 files, commit, push and open a PR targeting `main`.
