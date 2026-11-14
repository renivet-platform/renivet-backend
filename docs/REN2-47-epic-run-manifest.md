# REN2-47 backend execution manifest

**Epic:** REN2-47 — W2-U1 Brand & Admin Portal UX
**Owner direction:** Code-first Next.js design; Figma handoff is waived for this pass. Backend and frontend PRs remain separate; the owner reviews and merges.
**Repository:** `renivet-backend`
**Base:** `origin/main` at `83db06e10c37b9e258971142939a83c0d1337465`
**Branch:** `epic/REN2-47-brand-admin-portal-ux-20261115`
**Frontend branch:** `epic/REN2-47-w2-portal-completion`

## Scope and constraints

Backend work is limited to contracts used by the REN2-47 portal and corrections needed to make those contracts usable. W1 sessions, database-derived permissions, maker-checker, CSRF, fresh MFA for privileged admin decisions, and membership-derived brand scope remain authoritative. Do not seed permissions or review records, activate gated routes, apply migrations to an existing database, deploy, or claim runtime readiness without evidence.

## Child traceability

| Issue | Backend/API contribution | Current boundary |
|---|---|---|
| REN2-95 | Reconcile the portal operation map to current OpenAPI and document the code-first handoff. | Owner waived Figma; runtime permissions and activation gates remain open. |
| REN2-96 | Existing category, product list/detail, and progressive draft routes provide the editor contract. | Use current routes and version checks; no new catalog schema. |
| REN2-97 | Make seller submission usable through the registered W1-scoped submit route and align its request contract to persisted versions. | Server computes and persists the frozen snapshot/hash; `catalog.submit` grants remain owner-managed. |
| REN2-98 | Existing import upload, mapping, immutable preview, confirm, results, retry APIs. | Preserve idempotency and stale-preview checks. |
| REN2-99 | No backend change; stock console remains gated while inventory routes are not registered. | Do not activate `InventoryModule` or invent stock values. |
| REN2-100 | Existing global-admin queue, exact detail, QC, pricing, claim, taxonomy, and publication APIs. | No grants or review rows are seeded; G07/G08/G14/G17 remain release gates. |

## Verification checkpoint

- Backend source required for the portal is already present on the latest origin main, including the seller submit route and admin queue/detail/decision APIs. This epic branch makes no backend runtime or schema change.
- The seller submission request keeps the published API contract. The client sends the required digest field together with draft, schema and row versions; the server computes the authoritative frozen revision snapshot and hash transactionally.
- Backend checks on this branch: lint PASS, typecheck PASS, tests PASS (206 passed, 4 skipped because disposable PostgreSQL/Redis services were not declared), build PASS, API contract check PASS.
- Frontend implementation adds the seller submit action, same-origin proxy enforcement, current-version/idempotency binding, and operation-map alignment for the registered admin APIs. Frontend checks: lint PASS, typecheck PASS, tests PASS (60/60), build PASS.
- No database command, permission grant, fixture seed, runtime gate change, deployment, direct push to main, PR merge, auto-merge, or Linear mutation was performed.

## Handoff

One final epic PR per changed repository is allowed after child work and cross-issue QA are review-ready. If acceptance still depends on real permission grants or persisted review submissions, report those as release gates; never seed them or mark the epic accepted. The owner alone reviews and merges.
