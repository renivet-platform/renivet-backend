-- REN2-51: append-only decisions for internal worker authorization.
CREATE TABLE platform.worker_job_authorizations (
  job_id uuid PRIMARY KEY REFERENCES platform.durable_jobs(id),
  actor_id text NOT NULL CHECK (actor_id ~ '^[a-z][a-z0-9._-]{0,127}$' OR actor_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  source_event_id uuid NOT NULL REFERENCES platform.outbox_events(id),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9._-]{0,127}$'),
  permitted_effects text[] NOT NULL CHECK (cardinality(permitted_effects) BETWEEN 1 AND 32),
  authorization_provenance text NOT NULL CHECK (authorization_provenance ~ '^[a-z][a-z0-9._-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX platform_worker_job_authorizations_source_idx
  ON platform.worker_job_authorizations(source_event_id, brand_id, created_at);
--> statement-breakpoint
CREATE FUNCTION platform.reject_worker_job_authorization_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'worker job authorization is immutable'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER worker_job_authorization_immutable
BEFORE UPDATE OR DELETE ON platform.worker_job_authorizations
FOR EACH ROW EXECUTE FUNCTION platform.reject_worker_job_authorization_mutation();
--> statement-breakpoint

CREATE TABLE platform.worker_authorization_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text NOT NULL CHECK (actor_type = 'worker'),
  actor_id text NOT NULL CHECK (actor_id ~ '^[a-z][a-z0-9._-]{0,127}$' OR actor_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  -- Intentionally no FK to durable_jobs: denied decisions commit on a second
  -- connection while the worker owns that job's lease row lock.
  job_id uuid NOT NULL,
  source_event_id uuid NOT NULL REFERENCES platform.outbox_events(id),
  brand_id uuid NULL REFERENCES brands.brands(id),
  source_brand_id uuid NULL REFERENCES brands.brands(id),
  -- Store the attempted target even when the supplied UUID is not a real brand.
  target_brand_id uuid NULL,
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9._-]{0,127}$'),
  effect_key text NOT NULL CHECK (effect_key ~ '^[a-z][a-z0-9._-]{0,127}$'),
  decision text NOT NULL CHECK (decision IN ('allowed','denied')),
  reason_code text NULL CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  authorization_provenance text NOT NULL CHECK (authorization_provenance ~ '^[a-z][a-z0-9._-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((decision = 'allowed' AND reason_code IS NULL AND brand_id IS NOT NULL AND brand_id = source_brand_id AND target_brand_id = source_brand_id)
      OR (decision = 'denied' AND reason_code IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX platform_worker_authorization_audit_job_idx ON platform.worker_authorization_audit(job_id, created_at, id);
--> statement-breakpoint
CREATE INDEX platform_worker_authorization_audit_source_idx ON platform.worker_authorization_audit(source_event_id, created_at, id);
--> statement-breakpoint
CREATE FUNCTION platform.reject_worker_authorization_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'worker authorization audit is append-only'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER worker_authorization_audit_append_only
BEFORE UPDATE OR DELETE ON platform.worker_authorization_audit
FOR EACH ROW EXECUTE FUNCTION platform.reject_worker_authorization_audit_mutation();
