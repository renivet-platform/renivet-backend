# Version-controlled Postman artifacts

NestJS decorators generate `openapi/renivet.openapi.json` and the checked-in TypeScript client type. The handwritten Postman collection in `collections/` contains runnable functional examples and assertions for REN2-21. The collection is intentionally not generated from OpenAPI, so refreshing the contract cannot erase tests or examples. A CI drift check verifies every collection request maps to an OpenAPI operation.

All examples use `.test` synthetic domains and runtime-only passphrases. Set `apiBaseUrl` to a local test server, for example `http://127.0.0.1:4000/api/v1`. The Postman CLI runs this local file against disposable PostgreSQL/Redis integration services in CI, with telemetry/report publishing disabled and no API key. No private Postman Cloud workspace is synchronized by CI in this task.

To regenerate and verify API artifacts after reviewing controller changes:

```powershell
npm run api:generate
npm run api:check
```

The integration test requires the Postman CLI (`postman`). Postman Desktop installs it, or install the same pinned version used by CI with `npm install --global postman-cli@1.80.0`.
