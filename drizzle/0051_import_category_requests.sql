-- Auto-file category requests from bulk imports without granting sellers taxonomy
-- mutation/publishing privileges. Staged source rows remain the authoritative
-- representation until a taxonomy admin creates and publishes the category.
CREATE TABLE imports.import_category_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  batch_id uuid NOT NULL,
  source_category_code text NOT NULL CHECK (length(btrim(source_category_code)) BETWEEN 1 AND 128),
  source_category_name text NOT NULL CHECK (length(btrim(source_category_name)) BETWEEN 1 AND 128),
  source_row_number integer NOT NULL CHECK (source_row_number > 0),
  requested_by uuid NOT NULL REFERENCES identity.users(id),
  request_state text NOT NULL DEFAULT 'PENDING'
    CHECK (request_state IN ('PENDING','RESOLVED','DECLINED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (batch_id,brand_id) REFERENCES imports.import_batches(id,brand_id),
  UNIQUE (brand_id,batch_id,source_category_code)
);
--> statement-breakpoint
CREATE INDEX import_category_requests_brand_state_idx
  ON imports.import_category_requests(brand_id,request_state,created_at,id);
--> statement-breakpoint
