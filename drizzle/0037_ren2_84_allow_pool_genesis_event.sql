-- The original base migration has an unnamed-by-feature duplicate nonzero
-- check in addition to stock_events_delta_nonzero. Remove it so the explicit
-- GENESIS zero-delta PHYSICAL detail can satisfy the same invariant.
ALTER TABLE inventory.stock_events
  DROP CONSTRAINT stock_events_check;
