# REN2-48 Epic Run Manifest — Backend

- Parent: REN2-48 — Quality, Observability & Activation Gates
- Branch: `epic/REN2-48-quality-observability-activation-gates`
- Repository: `renivet-platform/renivet-backend`
- Base `origin/main` SHA at start: `c49dc892afab5aa954d4849f9f02e31d3f1342dc`
- Initial branch head: `c49dc892afab5aa954d4849f9f02e31d3f1342dc`
- Scope approval: owner approved coordinated Backend + Engineering OS work and one PR per repository.
- Owner controls: owner alone reviews/approves/merges; no direct main push, merge, auto-merge, deployment, existing DB mutation or Linear Done updates.
- Plan: Engineering OS `docs/superpowers/plans/2026-11-11-ren2-48-quality-observability-activation-gates.md`.
- Planned children: REN2-101 through REN2-109, in dependency order from the saved plan.
- Live blocker: REN2-104 depends on REN2-99, which remains Todo and whose merged frontend handoff is explicitly provisional. REN2-108 cannot claim completion until authorized retention durations/legal-hold rules exist.
- Contract ruling from owner: candidate operation count is 47; backend and Engineering OS candidate YAML contain 47 unique operations. Do not activate unimplemented routes.

## Baseline evidence

- `npm ci` — PASS; npm reported 11 moderate advisories (not changed as out of scope).
- `npm run lint` — PASS.
- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `npm test` — PASS, 149 passed, 4 skipped, 0 failed on rerun. A first full run had a transient live-server startup timeout; the isolated live-server test passed.
- `npm run api:check` — PASS; 47 candidate operations, 31 implemented W2 routes; runtime OpenAPI remains route-generated.
- Disposable PostgreSQL 16 epic acceptance run — NOT YET EXECUTED.
- GitHub checks for Epic 48 commits — NOT YET AVAILABLE.

## Per-child commit ledger

| Issue | Commit SHA | Tests / evidence | State |
|---|---|---|---|
| REN2-101 | f9254ccc57d410d2cb03396e256063374d898f32 | Backend candidate count matches owner-approved 47; 
pm run api:check PASS; focused 47-operation authorization matrix PASS | Verified |
| REN2-102 | Pending | Pending | Not started |
| REN2-103 | Pending | Pending | Not started |
| REN2-104 | Blocked by REN2-99 | None | Blocked |
| REN2-105 | Pending | Pending | Not started |
| REN2-106 | Pending | Pending | Not started |
| REN2-107 | Blocked until upstream evidence complete | None | Not started |
| REN2-108 | Pending policy; no durations authorized | None | Partially blocked |
| REN2-109 | Pending REN2-105 | Pending | Not started |
