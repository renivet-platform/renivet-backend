-- Trusted checkout allocation is a service-authored inventory command. Keep
-- user receipts intact while recording the service principal and source event.
ALTER TABLE inventory.stock_command_receipts
  ALTER COLUMN actor_user_id DROP NOT NULL,
  ADD COLUMN actor_service_principal text NULL
    CHECK (actor_service_principal IS NULL OR actor_service_principal ~ '^[a-z][a-z0-9._-]{0,127}$'),
  ADD COLUMN source_event_id uuid NULL REFERENCES platform.outbox_events(id),
  ADD CONSTRAINT stock_command_receipts_exactly_one_actor
    CHECK ((actor_user_id IS NULL) <> (actor_service_principal IS NULL));
--> statement-breakpoint

ALTER TABLE inventory.stock_events
  ADD COLUMN actor_service_principal text NULL
    CHECK (actor_service_principal IS NULL OR actor_service_principal ~ '^[a-z][a-z0-9._-]{0,127}$'),
  ADD COLUMN source_event_id uuid NULL REFERENCES platform.outbox_events(id),
  ADD CONSTRAINT stock_events_single_actor CHECK (actor_user_id IS NULL OR actor_service_principal IS NULL);
--> statement-breakpoint

CREATE INDEX stock_events_source_event_idx
  ON inventory.stock_events(source_event_id) WHERE source_event_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX stock_command_receipts_source_event_idx
  ON inventory.stock_command_receipts(source_event_id) WHERE source_event_id IS NOT NULL;
