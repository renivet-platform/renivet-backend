# REN2-53 implementation plan: brand eligibility handoff

1. Reconcile REN2-18 scope against the existing W1 identity and W2 catalog implementation; identify gaps without adding a duplicate application or brand root.
2. Document the approved-brand, active-membership, and explicit permission requirements for catalog writes, and the fail-closed effects of suspension on draft mutation and storefront buyability.
3. Record initial inventory location ownership as an explicit I1/Brand Operations provisioning handoff; onboarding must not create stock or locations implicitly.
4. Preserve the REN2-10 Figma and required review evidence as a follow-up dependency; code screens do not satisfy that evidence.
5. Add a PostgreSQL regression proving brand suspension denies buyability without mutating an already published product; run repository checks and the targeted disposable-PostgreSQL suites.
