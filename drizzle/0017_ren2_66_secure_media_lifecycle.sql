-- REN2-66: private upload intents and a fail-closed media scan/derivative lifecycle.
-- No permission grant is created here; W1 role assignments remain owner-controlled.

INSERT INTO access.permissions (permission_code, resource, action, description)
VALUES ('media.write', 'media', 'write', 'Upload and complete brand-owned media assets')
ON CONFLICT (permission_code) DO NOTHING;
--> statement-breakpoint

-- Existing rows came from the design-only W2 base schema and may not have scan metadata.
-- NOT VALID preserves those rows while PostgreSQL enforces these rules on every new or changed row.
ALTER TABLE media.media_assets
  ALTER COLUMN sha256 DROP NOT NULL,
  ADD COLUMN file_name text NOT NULL DEFAULT 'upload',
  ADD COLUMN byte_length bigint NOT NULL DEFAULT 1,
  ADD COLUMN expected_sha256 char(64),
  ADD COLUMN upload_key text,
  ADD COLUMN upload_expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  ADD COLUMN derivative_state text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN rights_attested_by uuid REFERENCES identity.users(id),
  ADD COLUMN rights_attested_at timestamptz,
  ADD COLUMN row_version bigint NOT NULL DEFAULT 1,
  ADD COLUMN upload_idempotency_key text,
  ADD COLUMN upload_request_sha256 char(64),
  ADD COLUMN completion_idempotency_key text,
  ADD COLUMN completion_request_sha256 char(64),
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN rejection_code text,
  ADD CONSTRAINT media_assets_byte_length_valid CHECK (byte_length BETWEEN 1 AND 10485760),
  ADD CONSTRAINT media_assets_hashes_valid CHECK (
    (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$')
    AND (expected_sha256 IS NULL OR expected_sha256 ~ '^[0-9a-f]{64}$')
    AND (upload_request_sha256 IS NULL OR upload_request_sha256 ~ '^[0-9a-f]{64}$')
    AND (completion_request_sha256 IS NULL OR completion_request_sha256 ~ '^[0-9a-f]{64}$')
  ) NOT VALID,
  ADD CONSTRAINT media_assets_derivative_state_valid CHECK (derivative_state IN ('PENDING','READY','FAILED')),
  ADD CONSTRAINT media_assets_row_version_positive CHECK (row_version > 0),
  ADD CONSTRAINT media_assets_filename_valid CHECK (length(btrim(file_name)) BETWEEN 1 AND 160),
  ADD CONSTRAINT media_assets_upload_idempotency_pair CHECK (
    (upload_idempotency_key IS NULL AND upload_request_sha256 IS NULL)
    OR (upload_idempotency_key ~ '^[A-Za-z0-9._:-]{1,120}$' AND upload_request_sha256 IS NOT NULL)
  ),
  ADD CONSTRAINT media_assets_completion_idempotency_pair CHECK (
    (completion_idempotency_key IS NULL AND completion_request_sha256 IS NULL)
    OR (completion_idempotency_key ~ '^[A-Za-z0-9._:-]{1,120}$' AND completion_request_sha256 IS NOT NULL)
  ),
  ADD CONSTRAINT media_assets_clean_requires_hash_and_derivatives CHECK (
    scan_state <> 'CLEAN' OR (sha256 IS NOT NULL AND derivative_state = 'READY' AND completed_at IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT media_assets_rights_attestation_pair CHECK (
    (rights_attested_by IS NULL AND rights_attested_at IS NULL)
    OR (rights_attested_by IS NOT NULL AND rights_attested_at IS NOT NULL)
  );
--> statement-breakpoint

ALTER TABLE media.media_assets ALTER COLUMN file_name DROP DEFAULT;
--> statement-breakpoint

CREATE UNIQUE INDEX media_assets_brand_upload_idempotency_uq
  ON media.media_assets(brand_id, upload_idempotency_key) WHERE upload_idempotency_key IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX media_assets_brand_upload_key_uq
  ON media.media_assets(brand_id, upload_key) WHERE upload_key IS NOT NULL;
--> statement-breakpoint

CREATE INDEX media_assets_brand_state_created_idx
  ON media.media_assets(brand_id, scan_state, created_at DESC, id);
--> statement-breakpoint

CREATE TABLE media.media_derivatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  media_asset_id uuid NOT NULL,
  derivative_kind text NOT NULL CHECK (derivative_kind IN ('PREVIEW','THUMBNAIL')),
  storage_key text NOT NULL,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL CHECK (mime_type = 'image/webp'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 10485760),
  width integer NOT NULL CHECK (width > 0 AND width <= 1600),
  height integer NOT NULL CHECK (height > 0 AND height <= 1600),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (media_asset_id, brand_id) REFERENCES media.media_assets(id, brand_id),
  UNIQUE (media_asset_id, derivative_kind),
  UNIQUE (brand_id, storage_key)
);
--> statement-breakpoint

CREATE INDEX media_derivatives_brand_asset_idx ON media.media_derivatives(brand_id, media_asset_id);
--> statement-breakpoint

CREATE TABLE media.upload_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  media_asset_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  request_id text NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 160),
  event_name text NOT NULL CHECK (event_name IN ('upload_intent_issued','upload_cleaned','upload_rejected')),
  scan_state text NOT NULL CHECK (scan_state IN ('PENDING','CLEAN','REJECTED')),
  rights_state text NOT NULL CHECK (rights_state IN ('UNVERIFIED','ATTESTED','REVIEWED','REVOKED')),
  reason_code text NULL CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  FOREIGN KEY (media_asset_id, brand_id) REFERENCES media.media_assets(id, brand_id)
);
--> statement-breakpoint

CREATE INDEX media_upload_audit_asset_created_idx
  ON media.upload_audit_events(brand_id, media_asset_id, created_at, id);
--> statement-breakpoint

CREATE FUNCTION media.reject_upload_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MEDIA_UPLOAD_AUDIT_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER media_upload_audit_immutable
BEFORE UPDATE OR DELETE ON media.upload_audit_events
FOR EACH ROW EXECUTE FUNCTION media.reject_upload_audit_mutation();
--> statement-breakpoint

CREATE FUNCTION media.guard_asset_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.scan_state IN ('CLEAN','REJECTED') THEN
    RAISE EXCEPTION 'MEDIA_ASSET_TERMINAL' USING ERRCODE = '23514';
  END IF;
  IF NEW.scan_state NOT IN ('PENDING','CLEAN','REJECTED') THEN
    RAISE EXCEPTION 'MEDIA_SCAN_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.brand_id <> OLD.brand_id OR NEW.id <> OLD.id OR NEW.storage_key <> OLD.storage_key
    OR NEW.upload_key <> OLD.upload_key OR NEW.mime_type <> OLD.mime_type
    OR NEW.file_name <> OLD.file_name OR NEW.byte_length <> OLD.byte_length
    OR NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256
    OR NEW.rights_state <> OLD.rights_state
    OR NEW.rights_attested_by IS DISTINCT FROM OLD.rights_attested_by
    OR NEW.rights_attested_at IS DISTINCT FROM OLD.rights_attested_at
    OR NEW.upload_idempotency_key IS DISTINCT FROM OLD.upload_idempotency_key
    OR NEW.upload_request_sha256 IS DISTINCT FROM OLD.upload_request_sha256 THEN
    RAISE EXCEPTION 'MEDIA_ASSET_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.scan_state = 'CLEAN' AND (NEW.sha256 IS NULL OR NEW.derivative_state <> 'READY' OR NEW.completed_at IS NULL) THEN
    RAISE EXCEPTION 'MEDIA_CLEAN_REQUIRES_VALIDATED_DERIVATIVES' USING ERRCODE = '23514';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'MEDIA_ASSET_ROW_VERSION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER media_asset_lifecycle_guard
BEFORE UPDATE ON media.media_assets
FOR EACH ROW EXECUTE FUNCTION media.guard_asset_lifecycle();
--> statement-breakpoint

CREATE FUNCTION media.require_clean_derivatives() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  derivative_count integer;
BEGIN
  IF NEW.scan_state = 'CLEAN' THEN
    SELECT count(DISTINCT derivative_kind) INTO derivative_count
      FROM media.media_derivatives
      WHERE media_asset_id=NEW.id AND brand_id=NEW.brand_id;
    IF derivative_count <> 2 THEN
      RAISE EXCEPTION 'MEDIA_CLEAN_REQUIRES_PREVIEW_AND_THUMBNAIL' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER media_clean_requires_derivatives
AFTER INSERT OR UPDATE ON media.media_assets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.scan_state = 'CLEAN')
EXECUTE FUNCTION media.require_clean_derivatives();
