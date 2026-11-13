-- REN2-84: match Master A4. Allocated but not physically dispatched is one
-- bucket (A); never deduct a separate pre-commit allocation amount.
ALTER TABLE inventory.stock_events
  DROP CONSTRAINT stock_events_delta_nonzero,
  DROP COLUMN delta_pre_commit_allocations,
  ADD CONSTRAINT stock_events_delta_nonzero CHECK (
    delta_physical <> 0 OR delta_quarantined <> 0 OR delta_other_non_sellable <> 0
    OR delta_allocated <> 0 OR delta_buffer <> 0
  );
--> statement-breakpoint

ALTER TABLE inventory.stock_balances
  DROP CONSTRAINT stock_balances_physical_covers_quarantine_and_commitments,
  DROP CONSTRAINT IF EXISTS stock_balances_physical_covers_all_non_sellable_and_commitments,
  DROP COLUMN pre_commit_allocations;
--> statement-breakpoint

ALTER TABLE inventory.stock_movements
  DROP COLUMN delta_pre_commit_allocations;
--> statement-breakpoint

ALTER TABLE inventory.stock_commitment_events
  DROP COLUMN delta_pre_commit_allocations;
--> statement-breakpoint
