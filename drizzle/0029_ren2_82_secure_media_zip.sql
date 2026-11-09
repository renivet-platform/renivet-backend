-- REN2-82: immutable brand-owned SKU/variant mapping and durable ZIP import work.
ALTER TABLE imports.import_uploads DROP CONSTRAINT import_uploads_source_kind_check;
ALTER TABLE imports.import_uploads DROP CONSTRAINT import_uploads_mime_type_check;
ALTER TABLE imports.import_uploads DROP CONSTRAINT import_uploads_byte_length_check;
ALTER TABLE imports.import_uploads ADD CONSTRAINT import_uploads_source_kind_check
  CHECK (source_kind IN ('RENIVET_CSV','RENIVET_XLSX','SHOPIFY_CSV','UNIWARE_CSV','GENERIC_CSV','MEDIA_ZIP'));
ALTER TABLE imports.import_uploads ADD CONSTRAINT import_uploads_mime_type_check
  CHECK (mime_type IN ('text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/zip'));
ALTER TABLE imports.import_uploads ADD CONSTRAINT import_uploads_byte_length_check
  CHECK (byte_length BETWEEN 1 AND 104857600);
ALTER TABLE imports.import_uploads ADD CONSTRAINT import_uploads_id_brand_kind_uq UNIQUE(id,brand_id,source_kind);

CREATE TABLE media.zip_mapping_manifests (
  id uuid PRIMARY KEY,
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  created_by uuid NOT NULL REFERENCES identity.users(id),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 120),
  request_sha256 char(64) NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  rights_attested boolean NOT NULL CHECK(rights_attested),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,brand_id),
  UNIQUE(brand_id,idempotency_key)
);
CREATE TABLE media.zip_mapping_manifest_items (
  manifest_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  sku text NOT NULL CHECK(sku ~ '^[A-Za-z0-9_.-]{1,40}$'),
  sku_norm text GENERATED ALWAYS AS (upper(btrim(sku))) STORED,
  product_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(manifest_id,sku_norm),
  UNIQUE(manifest_id,brand_id,sku_norm),
  UNIQUE(manifest_id,variant_id),
  FOREIGN KEY(manifest_id,brand_id) REFERENCES media.zip_mapping_manifests(id,brand_id),
  FOREIGN KEY(variant_id,product_id,brand_id) REFERENCES catalogue.product_variants(id,product_id,brand_id)
);
CREATE INDEX zip_mapping_manifest_items_variant_idx ON media.zip_mapping_manifest_items(brand_id,variant_id);
CREATE TRIGGER zip_mapping_manifests_immutable BEFORE UPDATE OR DELETE ON media.zip_mapping_manifests
  FOR EACH ROW EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
CREATE TRIGGER zip_mapping_manifest_items_immutable BEFORE UPDATE OR DELETE ON media.zip_mapping_manifest_items
  FOR EACH ROW EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();

CREATE TABLE media.zip_import_batches (
  id uuid PRIMARY KEY,
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  file_upload_id uuid,
  source_kind text NOT NULL CHECK(source_kind IN ('MEDIA_ZIP','REMOTE_URL')),
  mapping_manifest_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES identity.users(id),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 120),
  request_sha256 char(64) NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','PROCESSING','PARTIAL','SUCCEEDED','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1 CHECK(row_version>0),
  failure_code text CHECK(failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  UNIQUE(id,brand_id),
  UNIQUE(brand_id,idempotency_key),
  UNIQUE(file_upload_id,brand_id),
  UNIQUE(id,brand_id,mapping_manifest_id),
  FOREIGN KEY(file_upload_id,brand_id,source_kind) REFERENCES imports.import_uploads(id,brand_id,source_kind),
  FOREIGN KEY(mapping_manifest_id,brand_id) REFERENCES media.zip_mapping_manifests(id,brand_id),
  CHECK ((source_kind='MEDIA_ZIP') = (file_upload_id IS NOT NULL)),
  CHECK((state IN ('SUCCEEDED','FAILED','PARTIAL')) = (completed_at IS NOT NULL))
);
CREATE INDEX zip_import_batches_brand_created_idx ON media.zip_import_batches(brand_id,created_at DESC,id);

CREATE TABLE media.zip_import_remote_items (
  batch_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  mapping_manifest_id uuid NOT NULL,
  sku text NOT NULL CHECK(sku ~ '^[A-Za-z0-9_.-]{1,40}$'),
  sku_norm text GENERATED ALWAYS AS (upper(btrim(sku))) STORED,
  slot smallint NOT NULL CHECK(slot BETWEEN 1 AND 99),
  source_url text NOT NULL CHECK(length(source_url) BETWEEN 9 AND 2048),
  source_url_sha256 char(64) NOT NULL CHECK(source_url_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(batch_id,sku_norm,slot),
  FOREIGN KEY(batch_id,brand_id,mapping_manifest_id) REFERENCES media.zip_import_batches(id,brand_id,mapping_manifest_id),
  FOREIGN KEY(mapping_manifest_id,brand_id,sku_norm) REFERENCES media.zip_mapping_manifest_items(manifest_id,brand_id,sku_norm)
);
CREATE TRIGGER zip_import_remote_items_immutable BEFORE UPDATE OR DELETE ON media.zip_import_remote_items
  FOR EACH ROW EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();

CREATE TABLE media.zip_import_effects (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  product_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  media_asset_id uuid,
  sku text NOT NULL CHECK(sku ~ '^[A-Za-z0-9_.-]{1,40}$'),
  slot smallint NOT NULL CHECK(slot BETWEEN 1 AND 99),
  source_path text NOT NULL CHECK(length(source_path) BETWEEN 1 AND 512),
  source_sha256 char(64) NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  effect_key char(64) NOT NULL CHECK(effect_key ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('PENDING','SUCCEEDED','FAILED')),
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY(batch_id,brand_id) REFERENCES media.zip_import_batches(id,brand_id),
  FOREIGN KEY(variant_id,product_id,brand_id) REFERENCES catalogue.product_variants(id,product_id,brand_id),
  FOREIGN KEY(media_asset_id,brand_id) REFERENCES media.media_assets(id,brand_id),
  UNIQUE(batch_id,variant_id,slot),
  UNIQUE(id,brand_id),
  UNIQUE(effect_key),
  CHECK((state='PENDING' AND completed_at IS NULL AND error_code IS NULL)
    OR (state='SUCCEEDED' AND completed_at IS NOT NULL AND error_code IS NULL AND media_asset_id IS NOT NULL)
    OR (state='FAILED' AND completed_at IS NOT NULL AND error_code IS NOT NULL))
);
CREATE INDEX zip_import_effects_batch_state_idx ON media.zip_import_effects(batch_id,state,variant_id,slot);

CREATE TABLE media.zip_import_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  manifest_id uuid,
  batch_id uuid,
  effect_id uuid,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  request_id text NOT NULL CHECK(length(btrim(request_id)) BETWEEN 1 AND 160),
  event_name text NOT NULL CHECK(event_name IN ('mapping_created','batch_queued','batch_failed','image_attached','image_rejected')),
  payload_sha256 char(64) NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY(manifest_id,brand_id) REFERENCES media.zip_mapping_manifests(id,brand_id),
  FOREIGN KEY(batch_id,brand_id) REFERENCES media.zip_import_batches(id,brand_id),
  FOREIGN KEY(effect_id,brand_id) REFERENCES media.zip_import_effects(id,brand_id),
  UNIQUE(effect_id,event_name,payload_sha256)
);
CREATE INDEX zip_import_audit_brand_created_idx ON media.zip_import_audit_events(brand_id,created_at,id);
CREATE UNIQUE INDEX zip_import_batch_failure_audit_once_uq ON media.zip_import_audit_events(batch_id,event_name,payload_sha256)
  WHERE event_name='batch_failed';
CREATE TRIGGER zip_import_audit_immutable BEFORE UPDATE OR DELETE ON media.zip_import_audit_events
  FOR EACH ROW EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
