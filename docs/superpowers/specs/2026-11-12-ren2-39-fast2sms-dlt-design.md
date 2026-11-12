# REN2-39 Fast2SMS DLT OTP Delivery Design

## Goal
Connect the existing Renivet phone-verification challenge to the owner-configured Fast2SMS DLT SMS service without moving OTP generation, expiry, throttling, or one-use verification out of Renivet.

## Current state
`OtpChallengeService` owns challenge generation and verification. `OTP_DELIVERY` currently uses `UnavailableOtpDelivery`, which performs no network I/O. The issue's prerequisite REN2-22 is Done. The owner selected Fast2SMS and confirmed the available approved message text may be used for phone verification.

## Approaches
1. Fast2SMS Smart OTP: use the provider's Smart OTP-specific ID and endpoints. This does not match the account menu shown by the owner.
2. Fast2SMS DLT SMS route (selected): POST the DLT Message ID, approved sender ID, destination, and variables to Fast2SMS, passing Renivet's own OTP as a template variable. This preserves Renivet as the OTP authority and matches the owner's available account features.
3. DLT manual route: send message text, sender, entity and content-template identifiers directly. This duplicates template text and increases mismatch risk; not selected because the account has a mapped DLT Manager template.

## Boundaries and safety
- No real SMS in CI or local automated tests; inject a fake HTTP transport.
- Missing or partial Fast2SMS configuration keeps phone delivery unavailable.
- Never log the API key, OTP, recipient phone number, raw provider response, or request body.
- Use HTTPS POST, bounded timeout, generic failures, and abort propagation.
- Continue using Renivet challenge issuance/verification, purpose binding, expiry, throttling and one-use consumption.
- Email delivery remains unavailable; this task only wires the phone-verification provider.
- Do not test against a real customer phone without explicit owner authorization.

## DLT variables
The approved template contains two variables: OTP, then expiry duration in minutes. The request supplies the Renivet-generated code and the challenge expiry rounded up to whole minutes.
