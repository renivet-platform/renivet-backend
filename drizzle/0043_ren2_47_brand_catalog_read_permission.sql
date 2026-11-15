-- REN2-47: brand owners need catalogue read access to enter the seller workspace.
-- This grants no user directly; access still requires an active brand-scoped role assignment.
INSERT INTO access.role_permissions (role_id, permission_id)
SELECT roles.id, permissions.id
FROM access.roles AS roles
JOIN access.permissions AS permissions ON permissions.permission_code = 'catalog.read'
WHERE roles.role_code = 'brand_owner'
ON CONFLICT (role_id, permission_id) DO NOTHING;
