-- REN2-64: make brand-scoped INR price proposals versioned, attributable and auditable.
-- The approved-window exclusion and btree_gist extension were created by REN2-50;
-- retain that database-enforced [from,to) invariant and prove it again on PG16.

INSERT INTO access.permissions (permission_code, resource, action, description)
VALUES
  ('pricing.write', 'pricing', 'write', 'Propose brand-owned INR price versions'),
  ('pricing.read', 'pricing', 'read', 'Read price history for brand-owned variants')
ON CONFLICT (permission_code) DO NOTHING;
--> statement-breakpoint

ALTER TABLE catalogue.variant_prices
  ADD COLUMN row_version bigint NOT NULL DEFAULT 1,
  ADD COLUMN created_by uuid REFERENCES identity.users(id),
  ADD COLUMN reason_code text,
  ADD COLUMN decided_by uuid REFERENCES identity.users(id),
  ADD COLUMN decision_reason_code text,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint

ALTER TABLE catalogue.variant_prices
  ADD CONSTRAINT ren2_64_price_currency_inr CHECK (currency = 'INR'),
  ADD CONSTRAINT ren2_64_price_minor_safe_integer CHECK (
    amount_minor <= 9007199254740991 AND mrp_minor <= 9007199254740991
  ),
  ADD CONSTRAINT ren2_64_price_rule_version_positive CHECK (rule_version > 0),
  ADD CONSTRAINT ren2_64_price_row_version_positive CHECK (row_version BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT ren2_64_price_reason_code_valid CHECK (
    reason_code IS NULL OR (length(btrim(reason_code)) BETWEEN 1 AND 100 AND reason_code !~ '[[:cntrl:]]')
  ),
  ADD CONSTRAINT ren2_64_price_decision_fields_complete CHECK (
    (decided_by IS NULL AND decision_reason_code IS NULL AND decided_at IS NULL)
    OR (decided_by IS NOT NULL AND decision_reason_code IS NOT NULL AND length(btrim(decision_reason_code)) BETWEEN 1 AND 100 AND decided_at IS NOT NULL)
  );
--> statement-breakpoint

CREATE TABLE catalogue.price_mutation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  operation text NOT NULL CHECK (operation = 'proposeVariantPrice'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,120}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  price_id uuid NOT NULL,
  response_payload jsonb NOT NULL CHECK (jsonb_typeof(response_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (variant_id, brand_id) REFERENCES catalogue.product_variants(id, brand_id),
  FOREIGN KEY (price_id, brand_id, variant_id) REFERENCES catalogue.variant_prices(id, brand_id, variant_id),
  UNIQUE (brand_id, actor_user_id, operation, idempotency_key)
);
--> statement-breakpoint

CREATE INDEX ren2_64_price_receipts_variant_created_idx
  ON catalogue.price_mutation_receipts (brand_id, variant_id, created_at DESC);
--> statement-breakpoint

CREATE FUNCTION catalogue.prevent_price_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PRICE_RECEIPT_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER ren2_64_price_receipt_append_only
BEFORE UPDATE OR DELETE ON catalogue.price_mutation_receipts
FOR EACH ROW EXECUTE FUNCTION catalogue.prevent_price_receipt_mutation();
--> statement-breakpoint

CREATE INDEX ren2_64_price_history_idx
  ON catalogue.variant_prices (brand_id, variant_id, valid_from DESC, created_at DESC, id DESC);
--> statement-breakpoint

ALTER TABLE catalogue.price_audit_events
  ADD CONSTRAINT ren2_64_price_audit_actor_fk FOREIGN KEY (actor_user_id) REFERENCES identity.users(id);
--> statement-breakpoint

CREATE FUNCTION catalogue.prevent_price_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PRICE_AUDIT_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER ren2_64_price_audit_append_only
BEFORE UPDATE OR DELETE ON catalogue.price_audit_events
FOR EACH ROW EXECUTE FUNCTION catalogue.prevent_price_audit_mutation();
--> statement-breakpoint

CREATE FUNCTION catalogue.guard_price_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PRICE_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD.price_state IN ('APPROVED', 'REJECTED', 'EXPIRED') THEN
    RAISE EXCEPTION 'PRICE_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD.price_state = 'PENDING' THEN
    IF NEW.price_state NOT IN ('APPROVED', 'REJECTED')
      OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
      OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
      OR NEW.mrp_minor IS DISTINCT FROM OLD.mrp_minor
      OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
      OR NEW.valid_to IS DISTINCT FROM OLD.valid_to
      OR NEW.rule_version IS DISTINCT FROM OLD.rule_version
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
      OR NEW.row_version <> OLD.row_version + 1
      OR NEW.decided_by IS NULL
      OR NEW.decision_reason_code IS NULL
      OR NEW.decided_at IS NULL THEN
      RAISE EXCEPTION 'PRICE_PENDING_DECISION_REQUIRED' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER ren2_64_price_version_lifecycle
BEFORE UPDATE OR DELETE ON catalogue.variant_prices
FOR EACH ROW EXECUTE FUNCTION catalogue.guard_price_version_mutation();
