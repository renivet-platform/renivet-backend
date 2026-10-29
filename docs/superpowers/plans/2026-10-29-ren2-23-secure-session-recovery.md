# REN2-23 implementation plan

1. [x] Verify current issue, architecture, approved session defaults, API candidates and source-code state.
2. [x] Write the feature design and add failing session/CSRF tests before implementation.
3. [x] Implement opaque session lookup, sliding idle expiry, absolute expiry, rotation, logout revocation, CSRF and strict origin validation.
4. [x] Implement purpose-bound email recovery, password hashing and atomic session revocation using existing identity tables.
5. [x] Update NestJS-generated OpenAPI, handwritten Postman collections, configuration, CI and identity/Postman documentation.
6. [x] Run unit, full suite, disposable PostgreSQL/Redis integration, typecheck, lint, OpenAPI/Postman drift and container checks.
7. [ ] Self-review, commit and open a reviewable PR; keep it unmerged pending explicit owner approval.
