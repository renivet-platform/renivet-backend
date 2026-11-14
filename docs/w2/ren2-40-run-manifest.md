# REN2-40 epic run manifest

- Repository: `renivet-backend`
- Parent: REN2-40 — Foundation Readiness
- Owner-authorized child scope: REN2-54 and REN2-55 only
- Branch: `epic/REN2-40-foundation-readiness-20261115`
- Base `origin/main`: `eba6c8bf58772c69f0e92aab536009e2780c4c5f`
- Baseline was clean before implementation.
- No existing/local/staging/production database is authorized for migration or mutation. Integration checks must use the disposable PostgreSQL 16 CI database.
- Child sequence: REN2-54 taxonomy fixture, then REN2-55 W1 eligibility handoff; each child is committed independently after its own review and checks.
- Cross-repo scope: none. No frontend or Engineering OS files are changed.
- Owner-approved taxonomy: eight apparel categories; shared size, color, material composition, fit and care instructions; applicable sleeve length, neckline, rise and inseam; Catalog Operations; Pilot v1; no new legal/compliance rules beyond current approved W2 policy.
- Owner-approved eligibility: approved W1 brand applications use canonical membership and permission state; no new role or bypass.