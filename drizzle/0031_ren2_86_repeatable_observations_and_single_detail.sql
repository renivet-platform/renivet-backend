-- REN2-86: preserve a source observation history instead of one row per source.
-- REN2-84: a committed stock event can never acquire a second typed detail.
ALTER TABLE inventory.stock_observations
  DROP CONSTRAINT stock_observations_brand_id_source_namespace_source_referen_key;
--> statement-breakpoint

CREATE INDEX stock_observations_source_latest_idx
  ON inventory.stock_observations(brand_id,source_namespace,source_reference,variant_id,location_id,source_as_of DESC,submitted_at DESC);
--> statement-breakpoint

ALTER TABLE inventory.stock_movements
  ADD CONSTRAINT stock_movements_one_detail_per_event UNIQUE(stock_event_id);
--> statement-breakpoint

ALTER TABLE inventory.stock_commitment_events
  ADD CONSTRAINT stock_commitment_events_one_detail_per_event UNIQUE(stock_event_id);
--> statement-breakpoint

ALTER TABLE inventory.stock_buffer_events
  ADD CONSTRAINT stock_buffer_events_one_detail_per_event UNIQUE(stock_event_id);
--> statement-breakpoint
