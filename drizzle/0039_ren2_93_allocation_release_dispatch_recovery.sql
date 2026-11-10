-- REN2-93: retain shipped and released quantities separately so partial
-- shipment followed by cancellation cannot release already-dispatched stock.
ALTER TABLE inventory.stock_allocations
  ADD COLUMN released_quantity bigint NOT NULL DEFAULT 0 CHECK (released_quantity >= 0),
  ADD CONSTRAINT stock_allocations_shipped_released_within_quantity
    CHECK (dispatched_quantity + released_quantity <= quantity);
--> statement-breakpoint

ALTER TABLE inventory.stock_command_receipts
  DROP CONSTRAINT stock_command_receipts_actor_service_principal_check,
  ADD CONSTRAINT stock_command_receipts_actor_service_principal_check CHECK (
    actor_service_principal IS NULL OR actor_service_principal ~ '^[a-z][a-z0-9._-]{0,127}$' OR
    actor_service_principal ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );
--> statement-breakpoint

ALTER TABLE inventory.stock_events
  DROP CONSTRAINT stock_events_actor_service_principal_check,
  ADD CONSTRAINT stock_events_actor_service_principal_check CHECK (
    actor_service_principal IS NULL OR actor_service_principal ~ '^[a-z][a-z0-9._-]{0,127}$' OR
    actor_service_principal ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );
--> statement-breakpoint

CREATE FUNCTION inventory.protect_allocation_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.brand_id,NEW.variant_id,NEW.location_id,NEW.checkout_id,NEW.checkout_line_id,
      NEW.accepted_sequence,NEW.quantity,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.brand_id,OLD.variant_id,OLD.location_id,OLD.checkout_id,OLD.checkout_line_id,
      OLD.accepted_sequence,OLD.quantity,OLD.created_at) THEN
    RAISE EXCEPTION 'STOCK_ALLOCATION_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.dispatched_quantity < OLD.dispatched_quantity OR NEW.released_quantity < OLD.released_quantity THEN
    RAISE EXCEPTION 'STOCK_ALLOCATION_LIFECYCLE_NOT_MONOTONIC';
  END IF;
  IF (NEW.allocation_state='ALLOCATED' AND (NEW.dispatched_quantity<>0 OR NEW.released_quantity<>0)) OR
      (NEW.allocation_state='PARTIALLY_SHIPPED' AND
        (NEW.dispatched_quantity=0 OR NEW.dispatched_quantity+NEW.released_quantity>=NEW.quantity)) OR
      (NEW.allocation_state='DISPATCHED' AND
        (NEW.dispatched_quantity<>NEW.quantity OR NEW.released_quantity<>0)) OR
      (NEW.allocation_state='CANCELLED' AND
        (NEW.released_quantity=0 OR NEW.dispatched_quantity+NEW.released_quantity<>NEW.quantity)) THEN
    RAISE EXCEPTION 'STOCK_ALLOCATION_LIFECYCLE_STATE_INVALID';
  END IF;
  IF OLD.allocation_state='ALLOCATED' AND NEW.allocation_state NOT IN ('ALLOCATED','PARTIALLY_SHIPPED','DISPATCHED','CANCELLED') OR
      OLD.allocation_state='PARTIALLY_SHIPPED' AND NEW.allocation_state NOT IN ('PARTIALLY_SHIPPED','DISPATCHED','CANCELLED') OR
      OLD.allocation_state IN ('DISPATCHED','CANCELLED','RECOVERY') AND NEW.allocation_state<>OLD.allocation_state THEN
    RAISE EXCEPTION 'STOCK_ALLOCATION_STATE_TRANSITION_INVALID';
  END IF;
  IF OLD.allocation_state IN ('DISPATCHED','CANCELLED','RECOVERY') AND
      ROW(NEW.dispatched_quantity,NEW.released_quantity,NEW.allocation_state)
        IS DISTINCT FROM ROW(OLD.dispatched_quantity,OLD.released_quantity,OLD.allocation_state) THEN
    RAISE EXCEPTION 'STOCK_ALLOCATION_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER stock_allocation_lifecycle_guard
  BEFORE UPDATE ON inventory.stock_allocations
  FOR EACH ROW EXECUTE FUNCTION inventory.protect_allocation_lifecycle();
--> statement-breakpoint

CREATE TABLE inventory.stock_paid_unavailable_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  checkout_id uuid NOT NULL,
  checkout_line_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  accepted_sequence bigint NOT NULL CHECK (accepted_sequence > 0),
  quantity bigint NOT NULL CHECK (quantity > 0),
  source_event_id uuid NOT NULL REFERENCES platform.outbox_events(id),
  actor_service_principal text NOT NULL CHECK (actor_service_principal ~ '^[a-z][a-z0-9._-]{0,127}$' OR
    actor_service_principal ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  reason_code text NOT NULL CHECK (reason_code IN ('NO_STOCK_POOL','STOCK_POOL_SUSPENDED','INSUFFICIENT_AVAILABLE_STOCK')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id,checkout_id,checkout_line_id,location_id)
);
--> statement-breakpoint

CREATE TRIGGER stock_paid_unavailable_cases_immutable
  BEFORE UPDATE OR DELETE ON inventory.stock_paid_unavailable_cases
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_stock_ledger_mutation();
--> statement-breakpoint

CREATE INDEX stock_paid_unavailable_cases_source_idx
  ON inventory.stock_paid_unavailable_cases(source_event_id);
