CREATE TABLE imports.import_uploads (
  id uuid PRIMARY KEY,
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  source_kind text NOT NULL CHECK (source_kind IN ('RENIVET_CSV','RENIVET_XLSX','SHOPIFY_CSV','UNIWARE_CSV','GENERIC_CSV')),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 160),
  mime_type text NOT NULL CHECK (mime_type IN ('text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 10485760),
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  storage_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONSUMED','EXPIRED')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(brand_id,idempotency_key),
  UNIQUE(id,brand_id),
  CHECK ((status='CONSUMED') = (consumed_at IS NOT NULL))
);
CREATE INDEX import_uploads_expiry_idx ON imports.import_uploads(status,expires_at);
--> statement-breakpoint
ALTER TABLE imports.import_batches ADD COLUMN file_upload_id uuid NULL;
--> statement-breakpoint
ALTER TABLE imports.import_batches ADD CONSTRAINT import_batch_upload_once UNIQUE(file_upload_id,brand_id);
--> statement-breakpoint
ALTER TABLE imports.import_batches ADD CONSTRAINT import_batch_upload_same_brand_fk
  FOREIGN KEY(file_upload_id,brand_id) REFERENCES imports.import_uploads(id,brand_id);
