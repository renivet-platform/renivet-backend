-- REN2-87: every effective D05 policy state is versioned and retained.
ALTER TABLE inventory.stock_adjustment_policy_history
  ADD COLUMN source_status text NOT NULL DEFAULT 'PROVISIONAL'
    CHECK (source_status IN ('PROVISIONAL','OWNER_CONFIRMED'));
--> statement-breakpoint

INSERT INTO inventory.stock_adjustment_policy_history(policy_key,version,absolute_units,percentage,effective_at,configured_by,evidence_reference,source_status)
SELECT policy_key,version,absolute_units,percentage,effective_at,configured_by,evidence_reference,source_status
FROM inventory.stock_adjustment_policy p
WHERE NOT EXISTS (SELECT 1 FROM inventory.stock_adjustment_policy_history h WHERE h.policy_key=p.policy_key AND h.version=p.version);
--> statement-breakpoint

CREATE FUNCTION inventory.require_new_adjustment_policy_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.version=NEW.version AND
    (OLD.absolute_units,OLD.percentage,OLD.effective_at,OLD.configured_by,OLD.evidence_reference,OLD.source_status)
    IS DISTINCT FROM
    (NEW.absolute_units,NEW.percentage,NEW.effective_at,NEW.configured_by,NEW.evidence_reference,NEW.source_status) THEN
    RAISE EXCEPTION 'STOCK_ADJUSTMENT_POLICY_VERSION_REQUIRED';
  END IF;
  IF TG_OP='UPDATE' AND OLD.version IS DISTINCT FROM NEW.version AND NEW.effective_at <= OLD.effective_at THEN
    RAISE EXCEPTION 'STOCK_ADJUSTMENT_POLICY_EFFECTIVE_AT_MUST_ADVANCE';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER stock_adjustment_policy_version_required
  BEFORE UPDATE ON inventory.stock_adjustment_policy
  FOR EACH ROW EXECUTE FUNCTION inventory.require_new_adjustment_policy_version();
--> statement-breakpoint

CREATE FUNCTION inventory.record_adjustment_policy_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO inventory.stock_adjustment_policy_history(policy_key,version,absolute_units,percentage,effective_at,configured_by,evidence_reference,source_status)
  VALUES(NEW.policy_key,NEW.version,NEW.absolute_units,NEW.percentage,NEW.effective_at,NEW.configured_by,NEW.evidence_reference,NEW.source_status);
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER stock_adjustment_policy_history_append
  AFTER UPDATE ON inventory.stock_adjustment_policy
  FOR EACH ROW WHEN (OLD.version IS DISTINCT FROM NEW.version)
  EXECUTE FUNCTION inventory.record_adjustment_policy_version();
--> statement-breakpoint
