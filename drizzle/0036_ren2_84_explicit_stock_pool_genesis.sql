-- REN2-84/85: journal the zero-state pool baseline at sequence one. The first
-- physical/commitment/buffer effect then starts at sequence two.
ALTER TABLE inventory.stock_events
  DROP CONSTRAINT stock_events_pool_sequence_check,
  ADD CONSTRAINT stock_events_pool_sequence_check CHECK(pool_sequence>=1),
  DROP CONSTRAINT stock_events_delta_nonzero,
  ADD CONSTRAINT stock_events_delta_nonzero CHECK(
    delta_physical<>0 OR delta_quarantined<>0 OR delta_other_non_sellable<>0
    OR delta_allocated<>0 OR delta_buffer<>0
    OR (event_kind='PHYSICAL' AND business_effect_key LIKE 'genesis.%'
      AND delta_physical=0 AND delta_quarantined=0 AND delta_other_non_sellable=0
      AND delta_allocated=0 AND delta_buffer=0)
  );
--> statement-breakpoint

ALTER TABLE inventory.stock_movements
  DROP CONSTRAINT stock_movements_check,
  ADD CONSTRAINT stock_movements_nonzero_or_genesis CHECK(
    delta_physical<>0 OR delta_quarantined<>0 OR delta_other_non_sellable<>0
    OR (movement_reason='GENESIS' AND source_type='SYSTEM'
      AND business_effect_key LIKE 'genesis.%' AND delta_physical=0
      AND delta_quarantined=0 AND delta_other_non_sellable=0)
  );
--> statement-breakpoint
