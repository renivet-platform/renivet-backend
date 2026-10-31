# REN2-26 Brand Membership, Permission, and Audit Schema

## Intent

Implement the first W1 brand authorization persistence slice in `renivet-backend`. It gives identity users approved, time-bounded brand memberships and extensible role/permission assignments, with permanent audit evidence for access changes.

## Evidence and authority

- Linear REN2-26 requires the canonical brand membership, permission, role-assignment, and audit model with migration and disposable PostgreSQL evidence.
- Controlling requirement: `SRS-AUTHZ-001`, `SRS-DATA-001`; decision: `EXD-005`, `AZ-01..04` in `ADR-W1-001`.
- The registered ERD archive `RENIVET_Complete_ERD_Import_Package_2026-10-22.zip` was found in Downloads and verified against the source register: SHA-256 `d8422b1080da7ffa4d880cba2f1fa3ea0000d6191bfb60fd18d15bb57100e119` (334,148 bytes). Its DBML defines `brands.brands`, `brands.brand_memberships`, `access.roles`, `access.permissions`, `access.role_permissions`, `access.role_assignments`, and `access.security_audit_events`. This is a logical source model, not previously reviewed executable DDL; constraints and indexes below are implementation decisions for this task.
- The business meaning of the first-slice role matrix is the proposal shown to and accepted for implementation by the owner in this conversation. It grants no product, order, payment, or finance permissions.

## Goals

- Keep the canonical ERD table names and link membership/assignments to `identity.users` and the canonical `brands.brands` table.
- Support both brand-scoped roles and Renivet-wide staff roles, with scope consistency enforced by PostgreSQL.
- Resolve only effective permissions: active user, assignment validity window, and (for brand access) approved brand plus active, joined, valid membership.
- Seed an explicit, narrow first-slice matrix for Renivet Admin, Renivet Support, Brand Owner, and Brand Staff.
- Deny access by default: only active, joined, approved-brand memberships and currently valid assignments can establish brand scope.
- Make authorization audit events append-only and retain them without automatic deletion.
- Test migrations, constraints, FK behavior, permission seeds, and audit immutability against disposable PostgreSQL 16.

## Non-goals

- No admin or seller UI, authorization HTTP endpoints, runtime guard/repository enforcement, or commercial domain permissions. Those belong to later REN2-27/28 and domain stories.
- No production/shared database migration, deployed service, external vendor integration, or public API.
- No automatic role promotion or user assignment bootstrap. Seeded role definitions grant nobody access.

## First-slice matrix

| Role code | Scope | Seeded permissions | Restrictions |
|---|---|---|---|
| `renivet_admin` | Global | `staff_access.manage`, `brand_membership.review`, `brand_membership.manage`, `access_audit.read` | Access administration only; no implicit commerce/finance access. Sensitive mutations require the existing MFA gate when runtime handlers are added. |
| `renivet_support` | Global | `account_status.read`, `brand_status.read` | Read-only status support; cannot grant/revoke roles, approve memberships, or access financial data. |
| `brand_owner` | Brand | `brand_membership.read`, `brand_membership.invite`, `brand_membership.revoke`, `brand_role.assign_staff`, `brand_access_audit.read` | Cannot assign global roles or promote another member to Brand Owner. |
| `brand_staff` | Brand | `brand_membership.read_self` | No member management or other brand access. No commerce permission is seeded. |

Permission keys are stable server-side identifiers, not API routes. Every unlisted permission is denied. The `brand_role.assign_staff` operation is intentionally distinct from assigning ownership so a Brand Owner cannot grant another owner role.

## Approaches considered

1. **Fixed role enum and user-role columns:** simple at first, but makes multiple brand memberships, different scopes, audit history, and later roles difficult. Rejected.
2. **Normalized role/permission catalog and scoped assignments:** follows the ERD, supports one user in multiple brands and globally scoped staff access, and permits reviewed permission changes through migrations. Selected.
3. **Arbitrary JSON policy per user:** flexible but makes uniqueness, foreign keys, audits, and reviewable permission evaluation weaker. Rejected.

## Data and integrity decisions

- Implement the ERD's `brands.brands` root because it is not yet present in this codebase and is required for real membership and assignment foreign keys; match its logical columns rather than inventing a parallel Brand entity.
- `brands.brand_memberships` has one durable row per `(user_id, brand_id)`, retains pending/active/suspended/revoked lifecycle, and uses `joined_at` to record activation. Rejoining/revoking changes the durable membership state; access changes are separately audited.
- `access.roles.scope_kind` and `access.role_assignments.scope_type` are restricted to `global` or `brand`. A composite FK plus check makes a global assignment omit `brand_id` and a brand assignment require it. Membership/assignment FKs do not cascade-delete.
- Role assignments have a single durable row per user, role, and scope. `active_from`/`active_until` define validity; revoked grants end by setting `active_until`, preserving the row and its audit trail.
- Catalog role-permission rows are migration-seeded. No staff user receives a role by default.
- `access.security_audit_events` follows ERD columns, accepts only safe action/subject/request/hash metadata, and rejects UPDATE/DELETE through a trigger. The application must supply a SHA-256 payload hash and never place secrets or raw PII in audit payloads. No cleanup job is added.
- PostgreSQL cannot check cross-table brand approval in a row-level CHECK. `access.effective_permissions` resolves the current principal, assignment window, brand onboarding state, and active membership together. Runtime handlers must query it and business repositories must still include the authorized tenant predicate (REN2-27/28).
- Regranting an expired/revoked role reopens the unique durable assignment row after writing an append-only audit event; separate assignment episodes are not stored in this first slice.

## Compatibility and safety

The migration is additive. It does not change existing identity rows or invoke an API. CI applies it twice and runs all checks only against the disposable PostgreSQL 16 service. No down migration is added; rollback/recovery remains an explicit release operation and no shared DB is touched.

## Implementation acceptance

- ERD table names/required columns and FK relationships match the verified archive.
- Database rejects invalid scope combinations, missing user/brand/role references, duplicate memberships/role grants, unknown states/actions, invalid validity windows, and audit edits/deletes.
- Seeded role/permission matrix is deterministic and grants no user access.
- Fresh migration, replay, disposable integration test (including effective-access denial and regrant), typecheck/lint/build/full unit suite, and CI PostgreSQL test all pass before PR.
- Trace the implementation and tests to REN2-26, SRS-AUTHZ-001, SRS-DATA-001, AZ-01/AZ-04, and T-DB-02..05. No API/Postman update is needed because no endpoint is added.
