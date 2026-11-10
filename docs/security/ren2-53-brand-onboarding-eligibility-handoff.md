# REN2-53 — Brand application eligibility and onboarding handoff

**Scope:** Backend reconciliation for REN2-53. This records the existing authorization and lifecycle boundary; it does not create a parallel application service, alter role grants, add public API operations, or migrate data.

## Existing source of truth and eligibility

REN2-18's application and review work does not require a second W2 brand root. W1 `brands.brands` and `brands.brand_memberships` remain canonical. `access.effective_permissions` evaluates current identity, approved brand state, active joined membership, and current role assignment. Catalog draft writes additionally require the explicit `catalog.write` permission. The permission remains ungranted by default; this task does not invent or seed a role mapping.

The existing brand access guard resolves the first-party session and server-side permission scope. Product draft mutations recheck live brand eligibility and permission in the transaction. A non-approved brand state or suspended/revoked membership is denied; callers cannot authorize themselves by supplying a brand ID.

## Suspension and visibility effects

When a brand is suspended, restricted, or archived, catalog draft writes are denied. Storefront buyability is also denied by the backend's live brand-state check, including for a product that had previously been published. The product and its publication record remain stored; suspension does not silently delete or rewrite seller content. Reinstatement is an explicit administrative state change and does not itself grant a user catalog permissions.

## Initial location handoff to I1

After W1 approval, Brand Operations / platform administration provisions the brand's workspace and any required stock locations through the approved inventory process, using the canonical W1 `brand_id`. This is an explicit handoff to I1, not an automatic consequence of application approval. Creating a location creates no stock. Stock enters only through an authorized inventory receipt or adjustment flow. Inventory routes remain dormant until their activation gates are approved.

## Design and review dependency

REN2-10's W1 onboarding Figma and its Product, Design, Security, Frontend, and Accessibility decisions remain external evidence. REN2-18's W2 application/review Figma and its Product, Security/Privacy, and Admin Operations decisions remain external evidence. The code implementation or its preview screens are not substitutes for those artifacts or approvals. Linear status alone does not establish that the evidence was recorded; owners must attach it to those design issues.

REN2-53 compares the handoff against REN2-18 and does not create duplicate design or application issues. No public API contract was added because the issue's proposed operations have no approved source IDs and the existing W1 session/permission path is authoritative.

## Evidence and release boundary

The existing PostgreSQL product-draft integration test verifies writes fail closed for suspended, restricted, and archived brand states and for suspended membership. The REN2-75 buyability integration suite now also verifies suspension denies checkout while retaining the published product record. These tests are development evidence only; they do not authorize runtime activation. W2 runtime gates (including G07) and the owner-approved role/permission mapping remain required before routes or grants are enabled.
