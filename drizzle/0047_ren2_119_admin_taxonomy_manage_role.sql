-- REN2-119: existing global Renivet admins need the permission behind
-- the Taxonomy Create category screen. No account is promoted by this migration.
-- Only the existing renivet_admin role receives this narrowly scoped capability.
INSERT INTO access.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM access.roles r
JOIN access.permissions p ON p.permission_code = 'taxonomy.manage'
WHERE r.role_code = 'renivet_admin' AND r.scope_kind = 'global'
ON CONFLICT (role_id, permission_id) DO NOTHING;
