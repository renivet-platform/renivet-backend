-- REN2-71 replay records for immutable product revision submissions.
-- This table does not grant catalog.submit; W1 permission mapping remains an owner-controlled gate.
INSERT INTO access.permissions (permission_code,resource,action,description)
VALUES ('catalog.submit','catalog','submit','Submit a complete product revision for independent review')
ON CONFLICT (permission_code) DO NOTHING;
--> statement-breakpoint

CREATE TABLE catalogue.product_submission_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  product_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,120}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  revision_id uuid NOT NULL,
  response_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id,brand_id) REFERENCES catalogue.products(id,brand_id),
  FOREIGN KEY (revision_id,product_id,brand_id) REFERENCES catalogue.product_revisions(id,product_id,brand_id),
  UNIQUE (brand_id,actor_user_id,idempotency_key),
  UNIQUE (revision_id)
);
--> statement-breakpoint

CREATE INDEX product_submission_receipts_created_idx ON catalogue.product_submission_receipts(created_at);
--> statement-breakpoint

CREATE TRIGGER product_submission_receipts_immutable
BEFORE UPDATE OR DELETE ON catalogue.product_submission_receipts
FOR EACH ROW EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
