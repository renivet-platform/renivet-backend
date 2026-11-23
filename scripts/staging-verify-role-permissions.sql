-- DEF-010: repeatable, READ-ONLY audit of W1/W2 RBAC grants, independent
-- of database-level CREATE/CONNECT rights.
-- Run after migrations/restore as a DB role with SELECT on access tables.
-- Never auto-promote users or grant missing permissions as a runtime hotfix.
DO $$
BEGIN
 IF current_database()<>'renivet_staging' THEN
   RAISE EXCEPTION 'Refusing role-permission verification outside renivet_staging';
 END IF;
 IF EXISTS (
   WITH expected(role_code,scope_kind,permission_code) AS (
     VALUES
    ('brand_owner','brand','brand_access_audit.read'),
    ('brand_owner','brand','brand_membership.invite'),
    ('brand_owner','brand','brand_membership.read'),
    ('brand_owner','brand','brand_membership.revoke'),
    ('brand_owner','brand','brand_role.assign_staff'),
    ('brand_owner','brand','catalog.read'),
    ('brand_owner','brand','catalog.submit'),
    ('brand_owner','brand','catalog.write'),
    ('brand_owner','brand','imports.read'),
    ('brand_owner','brand','inventory.adjust.propose'),
    ('brand_owner','brand','inventory.count'),
    ('brand_owner','brand','inventory.location.manage'),
    ('brand_owner','brand','inventory.read'),
    ('brand_owner','brand','inventory.reconcile'),
    ('brand_owner','brand','inventory.submit'),
    ('brand_owner','brand','media.write'),
    ('brand_staff','brand','brand_membership.read_self'),
    ('renivet_admin','global','access_audit.read'),
    ('renivet_admin','global','brand_membership.manage'),
    ('renivet_admin','global','brand_membership.review'),
    ('renivet_admin','global','inventory.adjust.approve'),
    ('renivet_admin','global','inventory.read'),
    ('renivet_admin','global','staff_access.manage'),
    ('renivet_admin','global','taxonomy.manage'),
    ('renivet_support','global','account_status.read'),
    ('renivet_support','global','brand_status.read')
   )
   SELECT 1 FROM expected e
   LEFT JOIN access.roles r ON r.role_code=e.role_code AND r.scope_kind=e.scope_kind
   LEFT JOIN access.permissions p ON p.permission_code=e.permission_code
   LEFT JOIN access.role_permissions rp ON rp.role_id=r.id AND rp.permission_id=p.id
   WHERE rp.id IS NULL
 ) THEN
   RAISE EXCEPTION 'DEF-010: expected W1/W2 role grants missing; reconcile migration history before enabling staging';
 END IF;
END $$;
-- Successful completion means the declared role-permission map is present.
-- It does not prove that individual users hold an authorized role assignment.
