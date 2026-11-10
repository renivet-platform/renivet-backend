-- REN2-83..89: complete the approved W2 stock ledger additively. No live data is
-- rewritten; existing pools start with zero pre-commit allocations.
ALTER TABLE inventory.stock_balances
  ADD COLUMN pre_commit_allocations bigint NOT NULL DEFAULT 0 CHECK (pre_commit_allocations >= 0),
  ADD CONSTRAINT stock_balances_physical_covers_quarantine_and_commitments
    CHECK (physical_on_hand >= quarantined + allocated_not_dispatched),
  ADD CONSTRAINT stock_balances_physical_covers_all_non_sellable_and_commitments
    CHECK (physical_on_hand >= quarantined + other_non_sellable + allocated_not_dispatched),
  ADD CONSTRAINT stock_balances_no_sellable_overflow
    CHECK (quarantined + other_non_sellable <= physical_on_hand);
--> statement-breakpoint

ALTER TABLE inventory.stock_events
  ADD COLUMN delta_pre_commit_allocations bigint NOT NULL DEFAULT 0,
  ADD COLUMN actor_user_id uuid NULL REFERENCES identity.users(id),
  ADD COLUMN before_balance jsonb NULL,
  ADD COLUMN after_balance jsonb NULL,
  ADD COLUMN correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD CONSTRAINT stock_events_delta_nonzero CHECK (
    delta_physical <> 0 OR delta_quarantined <> 0 OR delta_other_non_sellable <> 0
    OR delta_allocated <> 0 OR delta_pre_commit_allocations <> 0 OR delta_buffer <> 0
  );
--> statement-breakpoint

ALTER TABLE inventory.stock_movements
  ADD COLUMN delta_pre_commit_allocations bigint NOT NULL DEFAULT 0,
  ADD COLUMN source_timestamp timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint

ALTER TABLE inventory.stock_commitment_events
  ADD COLUMN delta_pre_commit_allocations bigint NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE inventory.stock_observations
  ADD COLUMN freshness_state text NOT NULL DEFAULT 'CURRENT'
    CHECK (freshness_state IN ('CURRENT','STALE','CONFLICT','REVIEW_REQUIRED')),
  ADD COLUMN expected_balance_version bigint NULL CHECK (expected_balance_version IS NULL OR expected_balance_version > 0),
  ADD COLUMN reviewed_by uuid NULL REFERENCES identity.users(id),
  ADD COLUMN reviewed_at timestamptz NULL,
  ADD COLUMN decision_reason text NULL;
--> statement-breakpoint

ALTER TABLE inventory.cycle_counts
  ADD COLUMN recorded_balance jsonb NULL,
  ADD COLUMN journal_digest char(64) NULL CHECK (journal_digest IS NULL OR journal_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN completed_at timestamptz NULL;
--> statement-breakpoint

ALTER TABLE inventory.reconciliation_cases
  ADD COLUMN expected_balance jsonb NULL,
  ADD COLUMN observed_balance jsonb NULL,
  ADD COLUMN row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  ADD COLUMN resolution_reason text NULL,
  ADD COLUMN resolution_adjustment_id uuid NULL REFERENCES inventory.stock_adjustments(id),
  ADD COLUMN resolved_by uuid NULL REFERENCES identity.users(id),
  ADD COLUMN resolved_at timestamptz NULL;
--> statement-breakpoint

CREATE TABLE inventory.reconciliation_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES inventory.reconciliation_cases(id),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  action text NOT NULL CHECK (action IN ('DISMISSED','COMPENSATED')),
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  expected_case_version integer NOT NULL CHECK (expected_case_version > 0),
  adjustment_id uuid NULL REFERENCES inventory.stock_adjustments(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 256),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((action = 'COMPENSATED') = (adjustment_id IS NOT NULL))
);
--> statement-breakpoint

ALTER TABLE inventory.stock_transfers
  ADD COLUMN transfer_reference text NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN out_event_id uuid NULL REFERENCES inventory.stock_events(id),
  ADD COLUMN in_event_id uuid NULL REFERENCES inventory.stock_events(id),
  ADD COLUMN out_event_kind text GENERATED ALWAYS AS ('PHYSICAL'::text) STORED,
  ADD COLUMN in_event_kind text GENERATED ALWAYS AS ('PHYSICAL'::text) STORED,
  ADD COLUMN accepted_by uuid NULL REFERENCES identity.users(id),
  ADD COLUMN accepted_at timestamptz NULL,
  ADD CONSTRAINT stock_transfer_distinct_locations CHECK (from_location_id <> to_location_id);
--> statement-breakpoint

ALTER TABLE inventory.stock_transfers
  ADD CONSTRAINT stock_transfer_out_event_pool_fk
    FOREIGN KEY(out_event_id,brand_id,variant_id,from_location_id,out_event_kind)
    REFERENCES inventory.stock_events(id,brand_id,variant_id,location_id,event_kind),
  ADD CONSTRAINT stock_transfer_in_event_pool_fk
    FOREIGN KEY(in_event_id,brand_id,variant_id,to_location_id,in_event_kind)
    REFERENCES inventory.stock_events(id,brand_id,variant_id,location_id,event_kind);
--> statement-breakpoint

CREATE FUNCTION inventory.reject_stock_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'STOCK_LEDGER_APPEND_ONLY';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER reconciliation_case_events_immutable
  BEFORE UPDATE OR DELETE ON inventory.reconciliation_case_events
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_stock_ledger_mutation();
--> statement-breakpoint

CREATE TABLE inventory.stock_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9._-]{0,63}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,120}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(brand_id,operation,idempotency_key)
);
--> statement-breakpoint

CREATE TRIGGER stock_command_receipts_immutable
  BEFORE UPDATE OR DELETE ON inventory.stock_command_receipts
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_stock_ledger_mutation();
--> statement-breakpoint

CREATE TABLE inventory.stock_adjustment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_id uuid NOT NULL REFERENCES inventory.stock_adjustments(id),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  action text NOT NULL CHECK(action IN ('PROPOSED','APPROVED','REJECTED','APPLIED')),
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  reason text NULL,
  stock_event_id uuid NULL REFERENCES inventory.stock_events(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TRIGGER stock_adjustment_events_immutable
  BEFORE UPDATE OR DELETE ON inventory.stock_adjustment_events
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_stock_ledger_mutation();
--> statement-breakpoint

CREATE TABLE inventory.stock_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK(quantity>0),
  condition text NOT NULL CHECK(condition IN ('DAMAGED','INSPECT','SELLABLE_CLAIMED')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 256),
  evidence_reference text NULL,
  state text NOT NULL DEFAULT 'PENDING_INSPECTION' CHECK(state IN ('PENDING_INSPECTION','ACCEPTED','REJECTED')),
  submitted_by uuid NOT NULL REFERENCES identity.users(id),
  reviewed_by uuid NULL REFERENCES identity.users(id),
  quarantine_event_id uuid NOT NULL REFERENCES inventory.stock_events(id),
  release_event_id uuid NULL REFERENCES inventory.stock_events(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  FOREIGN KEY(brand_id,variant_id,location_id) REFERENCES inventory.stock_balances(brand_id,variant_id,location_id),
  CHECK(reviewed_by IS NULL OR reviewed_by<>submitted_by),
  CHECK((state='ACCEPTED') = (release_event_id IS NOT NULL)),
  CHECK((state='PENDING_INSPECTION') = (reviewed_by IS NULL))
);
--> statement-breakpoint

CREATE TABLE inventory.stock_return_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES inventory.stock_returns(id),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  action text NOT NULL CHECK(action IN ('QUARANTINED','ACCEPTED','REJECTED')),
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  stock_event_id uuid NOT NULL REFERENCES inventory.stock_events(id),
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TRIGGER stock_return_events_immutable
  BEFORE UPDATE OR DELETE ON inventory.stock_return_events
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_stock_ledger_mutation();
--> statement-breakpoint

CREATE TABLE inventory.stock_adjustment_policy (
  policy_key text PRIMARY KEY CHECK (policy_key = 'D05'),
  version text NOT NULL CHECK (length(btrim(version)) BETWEEN 1 AND 64),
  absolute_units bigint NOT NULL CHECK (absolute_units > 0),
  percentage numeric(7,3) NOT NULL CHECK (percentage > 0 AND percentage <= 100),
  effective_at timestamptz NOT NULL DEFAULT now(),
  configured_by text NOT NULL CHECK (configured_by ~ '^[A-Za-z0-9._:-]{1,128}$'),
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 1 AND 256),
  source_status text NOT NULL DEFAULT 'PROVISIONAL' CHECK(source_status IN ('PROVISIONAL','OWNER_CONFIRMED'))
);
--> statement-breakpoint

CREATE TABLE inventory.stock_adjustment_policy_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_key text NOT NULL REFERENCES inventory.stock_adjustment_policy(policy_key),
  version text NOT NULL,
  absolute_units bigint NOT NULL,
  percentage numeric(7,3) NOT NULL,
  effective_at timestamptz NOT NULL,
  configured_by text NOT NULL,
  evidence_reference text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE inventory.stock_adjustments
  ADD COLUMN requires_independent_review boolean NOT NULL DEFAULT true,
  ADD COLUMN approval_policy_version text NOT NULL DEFAULT 'REN2-87-D05-v1';
--> statement-breakpoint

INSERT INTO inventory.stock_adjustment_policy(policy_key,version,absolute_units,percentage,configured_by,evidence_reference,source_status)
VALUES('D05','REN2-87-D05-v1',10,50,'system.seed','REN2-87 acceptance criteria; owner confirmation of source D05 required before release','PROVISIONAL')
ON CONFLICT(policy_key) DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION inventory.reject_stock_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'STOCK_LEDGER_APPEND_ONLY';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER stock_adjustment_policy_history_immutable
  BEFORE UPDATE OR DELETE ON inventory.stock_adjustment_policy_history
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_stock_ledger_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION inventory.require_one_typed_stock_detail() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE detail_count integer;
BEGIN
  SELECT
    (SELECT count(*) FROM inventory.stock_movements WHERE stock_event_id = NEW.id)
    + (SELECT count(*) FROM inventory.stock_commitment_events WHERE stock_event_id = NEW.id)
    + (SELECT count(*) FROM inventory.stock_buffer_events WHERE stock_event_id = NEW.id)
  INTO detail_count;
  IF detail_count <> 1 THEN RAISE EXCEPTION 'STOCK_EVENT_REQUIRES_EXACTLY_ONE_TYPED_DETAIL'; END IF;
  IF NEW.before_balance IS NULL OR NEW.after_balance IS NULL THEN
    RAISE EXCEPTION 'STOCK_EVENT_REQUIRES_BALANCE_SNAPSHOTS';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER stock_event_exactly_one_detail
  AFTER INSERT ON inventory.stock_events DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inventory.require_one_typed_stock_detail();
--> statement-breakpoint

INSERT INTO access.permissions(permission_code,resource,action,description) VALUES
  ('inventory.read','inventory','read','Read stock balances and movement history for an authorized brand.'),
  ('inventory.location.manage','inventory','location_manage','Manage locations for an authorized brand.'),
  ('inventory.submit','inventory','submit','Submit validated stock observations.'),
  ('inventory.adjust.propose','inventory','adjust_propose','Propose stock adjustments.'),
  ('inventory.adjust.approve','inventory','adjust_approve','Review stock adjustments as an independent authorized reviewer.'),
  ('inventory.count','inventory','count','Submit a physical cycle count.'),
  ('inventory.reconcile','inventory','reconcile','Resolve a stock reconciliation case.')
ON CONFLICT(permission_code) DO NOTHING;
--> statement-breakpoint

INSERT INTO access.role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM access.roles r CROSS JOIN access.permissions p
WHERE (r.role_code='brand_owner' AND p.permission_code IN
    ('inventory.read','inventory.location.manage','inventory.submit','inventory.adjust.propose','inventory.count','inventory.reconcile'))
   OR (r.role_code='renivet_admin' AND p.permission_code IN
    ('inventory.read','inventory.adjust.approve'))
ON CONFLICT DO NOTHING;
