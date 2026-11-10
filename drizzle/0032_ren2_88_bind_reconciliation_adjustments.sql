-- REN2-88: preserve the exact count snapshot and require its correction to be
-- an adjustment explicitly linked to that still-open case.
ALTER TABLE inventory.reconciliation_cases
  ADD COLUMN counted_physical bigint NULL CHECK (counted_physical IS NULL OR counted_physical >= 0),
  ADD COLUMN expected_balance_version bigint NULL CHECK (expected_balance_version IS NULL OR expected_balance_version > 0);
--> statement-breakpoint

ALTER TABLE inventory.stock_adjustments
  ADD COLUMN reconciliation_case_id uuid NULL REFERENCES inventory.reconciliation_cases(id);
--> statement-breakpoint

CREATE UNIQUE INDEX stock_adjustments_one_per_reconciliation_case
  ON inventory.stock_adjustments(reconciliation_case_id) WHERE reconciliation_case_id IS NOT NULL;
--> statement-breakpoint
