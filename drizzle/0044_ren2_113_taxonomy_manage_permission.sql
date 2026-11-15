-- REN2-113: register the global taxonomy proposal permission used by the
-- taxonomy administration API. Grants remain owner-managed role assignments.
INSERT INTO access.permissions (permission_code, resource, action, description)
VALUES ('taxonomy.manage', 'taxonomy', 'manage', 'Create and submit global taxonomy schema proposals.')
ON CONFLICT (permission_code) DO NOTHING;
