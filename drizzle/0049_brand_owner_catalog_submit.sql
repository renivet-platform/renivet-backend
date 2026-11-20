-- Brand owners can submit their own completed product drafts for independent review.
-- Review, approval, and publication remain separate permissions and roles.
INSERT INTO access.role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM access.roles AS role
JOIN access.permissions AS permission ON permission.permission_code = 'catalog.submit'
WHERE role.role_code = 'brand_owner'
  AND role.scope_kind = 'brand'
ON CONFLICT (role_id, permission_id) DO NOTHING;
