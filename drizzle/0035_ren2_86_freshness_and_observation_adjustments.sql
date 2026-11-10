-- REN2-86: preserve the source mode, publish age-based signals and link only
-- reviewed physical observations to the existing adjustment workflow.
ALTER TABLE inventory.stock_observations
  ADD COLUMN source_mode text NOT NULL DEFAULT 'MANUAL' CHECK(source_mode IN ('MANUAL','CONNECTED')),
  DROP CONSTRAINT stock_observations_freshness_state_check,
  ADD CONSTRAINT stock_observations_freshness_state_check
    CHECK(freshness_state IN ('CURRENT','ALERT','PAUSED','STALE','CONFLICT','REVIEW_REQUIRED'));
--> statement-breakpoint

ALTER TABLE inventory.stock_adjustments
  ADD COLUMN source_observation_id uuid NULL REFERENCES inventory.stock_observations(id),
  ADD COLUMN physical_before bigint NULL CHECK(physical_before IS NULL OR physical_before>=0),
  ADD COLUMN physical_after bigint NULL CHECK(physical_after IS NULL OR physical_after>=0),
  ADD CONSTRAINT stock_adjustment_physical_snapshot_check CHECK(
    (physical_before IS NULL AND physical_after IS NULL) OR
    (physical_before IS NOT NULL AND physical_after=physical_before+requested_physical_delta)
  );
--> statement-breakpoint

CREATE UNIQUE INDEX stock_adjustments_one_per_observation
  ON inventory.stock_adjustments(source_observation_id) WHERE source_observation_id IS NOT NULL;
--> statement-breakpoint
