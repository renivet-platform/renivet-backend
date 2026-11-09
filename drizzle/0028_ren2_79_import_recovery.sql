CREATE TABLE imports.import_retry_requests (
  id uuid PRIMARY KEY,
  brand_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  preview_revision bigint NOT NULL CHECK (preview_revision > 0),
  preview_hash char(64) NOT NULL CHECK (preview_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  error_codes text[] NOT NULL DEFAULT '{}',
  row_count integer NOT NULL CHECK (row_count >= 0),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','COMPLETED','PARTIAL','FAILED')),
  requested_by uuid NOT NULL REFERENCES identity.users(id),
  response_payload jsonb NOT NULL CHECK (jsonb_typeof(response_payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (batch_id,brand_id) REFERENCES imports.import_batches(id,brand_id),
  FOREIGN KEY (batch_id,preview_revision,preview_hash) REFERENCES imports.import_previews(batch_id,preview_revision,preview_hash),
  UNIQUE (brand_id,idempotency_key),
  UNIQUE (id,batch_id,brand_id)
);
--> statement-breakpoint
CREATE INDEX imports_retry_batch_created_idx ON imports.import_retry_requests(brand_id,batch_id,created_at DESC);
--> statement-breakpoint
CREATE FUNCTION imports.reject_retry_request_identity_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.brand_id IS DISTINCT FROM OLD.brand_id OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
    OR NEW.preview_revision IS DISTINCT FROM OLD.preview_revision OR NEW.preview_hash IS DISTINCT FROM OLD.preview_hash
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.error_codes IS DISTINCT FROM OLD.error_codes OR NEW.row_count IS DISTINCT FROM OLD.row_count
    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.response_payload IS DISTINCT FROM OLD.response_payload
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state='QUEUED' AND NEW.state IN ('COMPLETED','PARTIAL','FAILED'))
    OR (OLD.state='PARTIAL' AND NEW.state IN ('COMPLETED','FAILED'))
  ) THEN
    RAISE EXCEPTION 'INVALID_IMPORT_RETRY_TRANSITION';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER import_retry_requests_identity_immutable BEFORE UPDATE ON imports.import_retry_requests
FOR EACH ROW EXECUTE FUNCTION imports.reject_retry_request_identity_mutation();
