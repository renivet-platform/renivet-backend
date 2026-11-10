-- W2 persists W3-issued accepted-order and per-pool eligibility proofs.
-- W3 remains the authority that chooses admission order and eligible heads.
CREATE TABLE inventory.checkout_pool_admission_cursors (
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  last_eligibility_sequence bigint NOT NULL DEFAULT 0 CHECK (last_eligibility_sequence >= 0),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id,variant_id,location_id),
  FOREIGN KEY (variant_id,brand_id) REFERENCES catalogue.product_variants(id,brand_id),
  FOREIGN KEY (location_id,brand_id) REFERENCES inventory.stock_locations(id,brand_id)
);
--> statement-breakpoint

CREATE TABLE inventory.checkout_admission_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  checkout_id uuid NOT NULL,
  accepted_sequence bigint NOT NULL CHECK (accepted_sequence > 0),
  accepted_event_id uuid NOT NULL UNIQUE REFERENCES platform.outbox_events(id),
  eligibility_sequence bigint NOT NULL CHECK (eligibility_sequence > 0),
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  source_event_id uuid NOT NULL UNIQUE REFERENCES platform.outbox_events(id),
  outcome_kind text NOT NULL CHECK (outcome_kind IN ('ALLOCATION','SKIP')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (variant_id,brand_id) REFERENCES catalogue.product_variants(id,brand_id),
  FOREIGN KEY (location_id,brand_id) REFERENCES inventory.stock_locations(id,brand_id),
  UNIQUE (brand_id,accepted_sequence),
  UNIQUE (brand_id,variant_id,location_id,eligibility_sequence)
);
--> statement-breakpoint

CREATE TRIGGER checkout_admission_claims_immutable
  BEFORE UPDATE OR DELETE ON inventory.checkout_admission_claims
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_stock_ledger_mutation();
--> statement-breakpoint

CREATE TABLE inventory.checkout_admission_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  checkout_id uuid NOT NULL,
  checkout_line_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  accepted_sequence bigint NOT NULL CHECK (accepted_sequence > 0),
  eligibility_sequence bigint NOT NULL CHECK (eligibility_sequence > 0),
  quantity bigint NOT NULL CHECK (quantity > 0),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  accepted_event_id uuid NOT NULL REFERENCES platform.outbox_events(id),
  eligibility_event_id uuid NOT NULL UNIQUE REFERENCES platform.outbox_events(id),
  result_state text NOT NULL CHECK (result_state IN ('ALLOCATED','PAID_STOCK_UNAVAILABLE')),
  result_payload jsonb NOT NULL CHECK (jsonb_typeof(result_payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (variant_id,brand_id) REFERENCES catalogue.product_variants(id,brand_id),
  FOREIGN KEY (location_id,brand_id) REFERENCES inventory.stock_locations(id,brand_id),
  UNIQUE (brand_id,accepted_sequence),
  UNIQUE (brand_id,variant_id,location_id,eligibility_sequence),
  UNIQUE (brand_id,checkout_id,checkout_line_id,location_id)
);
--> statement-breakpoint

CREATE TRIGGER checkout_admission_proofs_immutable
  BEFORE UPDATE OR DELETE ON inventory.checkout_admission_proofs
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_stock_ledger_mutation();
--> statement-breakpoint

CREATE INDEX checkout_admission_proofs_accepted_event_idx
  ON inventory.checkout_admission_proofs(accepted_event_id);
--> statement-breakpoint

CREATE TABLE inventory.checkout_admission_skips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  checkout_id uuid NOT NULL,
  accepted_sequence bigint NOT NULL CHECK (accepted_sequence > 0),
  eligibility_sequence bigint NOT NULL CHECK (eligibility_sequence > 0),
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  accepted_event_id uuid NOT NULL REFERENCES platform.outbox_events(id),
  source_event_id uuid NOT NULL UNIQUE REFERENCES platform.outbox_events(id),
  reason_code text NOT NULL CHECK (reason_code IN ('PREDECESSOR_INVALID','PREDECESSOR_EXPIRED','PREDECESSOR_CANCELLED','OPERATOR_RECOVERY')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (variant_id,brand_id) REFERENCES catalogue.product_variants(id,brand_id),
  FOREIGN KEY (location_id,brand_id) REFERENCES inventory.stock_locations(id,brand_id),
  UNIQUE (brand_id,variant_id,location_id,eligibility_sequence),
  UNIQUE (brand_id,accepted_sequence),
  UNIQUE (accepted_event_id)
);
--> statement-breakpoint

CREATE TRIGGER checkout_admission_skips_immutable
  BEFORE UPDATE OR DELETE ON inventory.checkout_admission_skips
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_stock_ledger_mutation();
