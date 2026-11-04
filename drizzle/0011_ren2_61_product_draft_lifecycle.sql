-- REN2-61 progressive parent-product draft writes, idempotency and field lineage.
-- catalog.write is defined but deliberately not granted to any role here.
INSERT INTO access.permissions (permission_code, resource, action, description)
VALUES ('catalog.write', 'catalog', 'write', 'Create and update brand-owned product drafts')
ON CONFLICT (permission_code) DO NOTHING;
--> statement-breakpoint

CREATE TABLE catalogue.product_mutation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  operation text NOT NULL CHECK (operation IN ('createBrandProduct', 'updateBrandProduct')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,120}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  product_id uuid NOT NULL,
  response_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, brand_id) REFERENCES catalogue.products(id, brand_id),
  UNIQUE (brand_id, actor_user_id, operation, idempotency_key)
);
--> statement-breakpoint

CREATE INDEX product_mutation_receipts_created_idx
  ON catalogue.product_mutation_receipts (created_at);
--> statement-breakpoint

CREATE TABLE catalogue.product_field_lineage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  product_id uuid NOT NULL,
  field_path text NOT NULL CHECK (field_path ~ '^[a-z][a-zA-Z0-9_.-]{0,127}$'),
  source_kind text NOT NULL CHECK (source_kind IN ('MANUAL', 'IMPORT')),
  source_reference text NULL CHECK (source_reference IS NULL OR length(source_reference) <= 256),
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, brand_id) REFERENCES catalogue.products(id, brand_id)
);
--> statement-breakpoint

CREATE INDEX product_field_lineage_product_idx
  ON catalogue.product_field_lineage (brand_id, product_id, recorded_at, id);
