-- REN2-58 records durable global taxonomy submissions and publication receipts.
-- Publication notices are written to the existing transactional outbox in the same transaction.
CREATE TABLE catalogue.taxonomy_admin_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  action text NOT NULL CHECK (action IN ('propose', 'publish')),
  category_id uuid NOT NULL REFERENCES catalogue.categories(id),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  response_payload jsonb NOT NULL CHECK (jsonb_typeof(response_payload) = 'object'),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_user_id, action, idempotency_key)
);
--> statement-breakpoint

CREATE INDEX taxonomy_admin_events_category_time_idx
  ON catalogue.taxonomy_admin_events(category_id, occurred_at, id);
--> statement-breakpoint

CREATE TRIGGER taxonomy_admin_events_immutable
BEFORE UPDATE OR DELETE ON catalogue.taxonomy_admin_events
FOR EACH ROW EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
