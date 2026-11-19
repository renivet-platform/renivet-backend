-- REN2-125: a brand owner may manage their own products and upload product imagery.
-- Existing brand-scoped catalogue editors may upload imagery for the same approved brand.
-- Does not grant to read-only brand_staff or global Renivet admins; no account is promoted.
-- The W1 effective_permissions view still requires an active account, approved brand,
-- active brand membership and current brand-scoped role assignment.
WITH eligible_roles AS (
  SELECT r.id AS role_id, r.role_code
  FROM access.roles r
  WHERE r.scope_kind = 'brand'
    AND (
      r.role_code = 'brand_owner'
      OR EXISTS (
        SELECT 1 FROM access.role_permissions rp
        JOIN access.permissions existing ON existing.id = rp.permission_id
        WHERE rp.role_id = r.id AND existing.permission_code = 'catalog.write'
      )
    )
), grants AS (
  SELECT eligible_roles.role_id, p.id AS permission_id
  FROM eligible_roles
  JOIN access.permissions p ON (
    p.permission_code = 'media.write'
    OR (eligible_roles.role_code = 'brand_owner' AND p.permission_code = 'catalog.write')
  )
)
INSERT INTO access.role_permissions (role_id, permission_id)
SELECT role_id, permission_id FROM grants
ON CONFLICT (role_id, permission_id) DO NOTHING;
