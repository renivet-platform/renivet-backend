# Resend hosted OTP template delivery

## Goal

Use the published Resend templates for email verification and password recovery while retaining a quick `smtp`/`resend` provider switch and leaving phone SMS delivery unchanged.

## Scope

- Add a bounded, secret-safe Resend Email API adapter using the published aliases `email-verification` and `reset_password`.
- Select exactly one email provider using `EMAIL_OTP_PROVIDER` (`smtp` by default); keep Fast2SMS as the phone provider.
- Validate and document environment configuration, aliases, provider behavior, and local manual verification.
- Add unit tests with fake fetch/SMTP transports. Do not send live email or modify databases/API contracts.

## Verification

Run focused adapter/config tests, then repository lint, typecheck, full unit/integration test suite, build, and API contract check. Report each result explicitly. Review the final diff, commit only task files, push the branch, and open one PR; never merge.
