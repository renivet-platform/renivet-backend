# REN2-47 backend run manifest

**Epic:** REN2-47 — W2-U1 Brand & Admin Portal UX
**Owner authorization:** coordinated backend + frontend PRs approved in this conversation
**Repository:** `renivet-backend`
**Base:** `origin/main` at `53dd0d0de75de2d204c0ee306f2b1bfe7347b693`
**Branch:** `epic/REN2-47-brand-admin-portal-ux`

## Scope and constraints

This repository contributes only backend work needed by REN2-47. W1 session identity, database-derived permissions and brand scope remain authoritative. No new role grants, auth provider, deployed change, existing database mutation, or route activation is authorized. Engineering OS contract edits are outside the approved repository scope.

The 2026-11-10 activation-gate register says G07, G08 and G17 remain open. `InventoryModule` and its controllers are intentionally absent from `AppModule`. Catalog review/submission/publication services exist internally, but proposed QC/publication HTTP routes are not registered. Do not register protected routes, add permissive flags, or seed role permissions in this epic. The source-level implementations may be inspected and tested; UI must show gated states until the required owner/security/API evidence is approved.

## Child traceability

| Linear issue | Backend contribution | Required evidence / boundary |
|---|---|---|
| REN2-95 | Reconcile route map to actual registered OpenAPI. | Owner accepts the code-first design handoff for this pass and defers Figma. Security/API evidence and other issue-specific reviewer approvals remain external. |
| REN2-96 | Verify existing taxonomy/product draft routes and their DTO/error/security contracts. | No contract changes unless already approved and represented by current backend routes. |
| REN2-97 | Verify media, variant, price and claim routes used by the UI. | Preserve upload rights/scanning and independent review; no new permissions. |
| REN2-98 | Verify registered import upload/mapping/preview/confirm/results/retry routes. | Preserve immutable preview, idempotency and recovery semantics. |
| REN2-99 | Inspect dormant inventory source and gate coverage. | Do not register `InventoryModule`; G05–G08/G16–G17 remain release evidence. |
| REN2-100 | Inspect registered taxonomy/price/claim APIs and dormant QC/publication services. | Do not expose absent review, publish or restrict routes; G07/G08/G14/G17 remain open. |

## Current preflight checkpoint — 2026-11-11

The live parent has six children: REN2-95 through REN2-100. REN2-53 was merged in backend PR #65 (`53dd0d0de75de2d204c0ee306f2b1bfe7347b693`) and its Linear issue is Done. REN2-10, REN2-18, REN2-52 and the other external predecessors were also confirmed Done. This clears the external implementation preflight for REN2-95. The remaining child dependency chain is internal to this epic: REN2-95 precedes REN2-96/98/99/100, and REN2-96 precedes REN2-97.

Owner direction on 2026-11-11 accepts the code-first design handoff for REN2-95 and defers Figma for this implementation pass. This does not waive the live API/security-permission evidence, issue-specific reviews, or runtime gates. Do not mark any child complete based only on a prototype or implementation branch.

Both epic worktrees are on `epic/REN2-47-brand-admin-portal-ux`, based on current `origin/main` (`renivet-backend`: `53dd0d0de75de2d204c0ee306f2b1bfe7347b693`; `renivet-frontend`: `05f2b6a42f48886ecee74401d5988a80d99ff6b7`). `git fetch origin` completed for both. The frontend now has traceable provisional commits for REN2-95 through REN2-100; the backend change is this run manifest only, with no application source or route activation. The branches have not yet been pushed and no PR has been opened at this checkpoint.

Frontend verification observed in the epic worktree: `npm run typecheck` PASS, `npm run lint` PASS, `npm test` PASS (44 tests), `npm run build` PASS. These checks verify code quality/build only; they do not satisfy the live API/security permission-matrix acceptance or the outstanding design approval. Backend source is unchanged in this branch. Backend `npm run api:check` was started but did not complete: it stalled in `scripts/check-generated-api.cjs` while exporting the OpenAPI document, then was stopped after more than 90 seconds without output. No database command or route activation was run.

## Verification

Required final backend checks: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run api:check`, applicable disposable PostgreSQL 16 suites, and `git diff --check`. No test is reported as passed until its command completes and output is reviewed.

## Handoff rule

The epic protocol requires one final PR per authorized repository after every child is actually review-ready. Figma is deferred for REN2-95 by owner direction; if issue-specific reviews or runtime/API prerequisites remain outstanding, do not describe the epic as fully accepted or open a partial final PR without new owner direction. The owner alone reviews and merges.
