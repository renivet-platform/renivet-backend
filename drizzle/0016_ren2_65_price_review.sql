-- REN2-65: independent price decisions, current pricing permission and audit.
-- No role assignment is granted here; existing W1 authorization remains authoritative.

INSERT INTO access.permissions (permission_code, resource, action, description)
VALUES ('pricing.approve', 'pricing', 'approve', 'Review pending brand-owned price proposals')
ON CONFLICT (permission_code) DO NOTHING;
--> statement-breakpoint

ALTER TABLE catalogue.price_mutation_receipts
  DROP CONSTRAINT price_mutation_receipts_operation_check,
  ADD CONSTRAINT ren2_65_price_receipt_operation_check
    CHECK (operation IN ('proposeVariantPrice', 'decideVariantPrice'));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION catalogue.guard_price_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PRICE_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD.price_state IN ('APPROVED', 'REJECTED', 'EXPIRED') THEN
    RAISE EXCEPTION 'PRICE_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD.price_state = 'PENDING' THEN
    IF NEW.decided_by IS NOT NULL AND NEW.decided_by IS NOT DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'PRICE_MAKER_CHECKER_CONFLICT' USING ERRCODE = '23514';
    END IF;
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
