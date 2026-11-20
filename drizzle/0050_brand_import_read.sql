-- Allow existing brand import managers to read their scoped previews and results.
INSERT INTO access.permissions (permission_code, resource, action, description)
VALUES ('imports.read', 'imports', 'read', 'Read brand import previews and results')
ON CONFLICT (permission_code) DO NOTHING;
--> statement-breakpoint
INSERT INTO access.role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM access.roles role
JOIN access.permissions permission ON permission.permission_code = 'imports.read'
WHERE role.scope_kind = 'brand' AND role.role_code IN ('brand_owner', 'catalogue_editor')
ON CONFLICT (role_id, permission_id) DO NOTHING;
