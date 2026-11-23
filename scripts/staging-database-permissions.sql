-- DEF-010 — Explicit one-time PostgreSQL 16 staging role provisioning.
-- Run ONLY as DigitalOcean doadmin against DB renivet_staging, BEFORE migration
-- or restoring a backup. This script cannot repair owner mismatches on existing
-- objects; migrate/import as renivet_staging_user so that role owns them.
-- Requires privileged DO administrator; never grant SUPERUSER or CREATEROLE.
DO $$
BEGIN
  IF current_database() <> 'renivet_staging' OR current_user <> 'doadmin' THEN
    RAISE EXCEPTION 'Refusing provisioning outside staging as doadmin';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='renivet_staging_user') THEN
    RAISE EXCEPTION 'Expected staging role missing';
  END IF;
END $$;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE renivet_staging TO renivet_staging_user;
GRANT USAGE, CREATE ON SCHEMA public TO renivet_staging_user;
-- Object ACLs belong to their creating owner. Do not broadly grant DML on
-- every public table or on future doadmin-created objects.
-- Confirm the staging role can create schemas; this is required by the W1/W2
-- migrations (identity, brands, access, catalogue, inventory, etc.).
SELECT current_database() AS database_name, current_user AS executor,
  has_database_privilege('renivet_staging_user','renivet_staging','CREATE') AS schema_create_allowed;
