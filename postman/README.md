# Version-controlled Postman artifacts

NestJS decorators generate `openapi/renivet.openapi.json` and the checked-in TypeScript client type. Handwritten Postman collections in `collections/` contain runnable examples and assertions for REN2-21 registration/password authentication, REN2-22 OTP verification, REN2-23 session/logout/recovery behavior, and REN2-24 MFA status/enrollment/negative-proof/step-up/revocation cases. The collections are intentionally not generated from OpenAPI, so refreshing the contract cannot erase tests or examples. A CI drift check verifies every collection request maps to an OpenAPI operation. The complete positive TOTP/recovery lifecycle, including successful activation and recovery-code consumption, is exercised by the provider-independent Nest HTTP integration test against disposable PostgreSQL/Redis; the Postman cloud collection is not synchronized by CI.

All examples use `.test` synthetic domains and runtime-only passphrases. Set `apiBaseUrl` to a local test server, for example `http://127.0.0.1:4000/api/v1`. The Postman CLI runs this local file against disposable PostgreSQL/Redis integration services in CI, with telemetry/report publishing disabled and no API key. No private Postman Cloud workspace is synchronized by CI in this task.

To regenerate and verify API artifacts after reviewing controller changes:

```powershell
npm run api:generate
npm run api:check
```

The integration test requires the Postman CLI (`postman`). Postman Desktop installs it, or install the same pinned version used by CI with `npm install --global postman-cli@1.80.0`.
