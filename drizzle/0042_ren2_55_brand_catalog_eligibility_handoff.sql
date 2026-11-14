-- REN2-55 records the internal W1 application-review to catalog-eligibility handoff.
-- It grants no roles and exposes no public route. Existing W1 reviewers and memberships remain authoritative.
CREATE TABLE brands.brand_catalog_eligibility_events (
  event_id uuid PRIMARY KEY,
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  applicant_user_id uuid NOT NULL REFERENCES identity.users(id),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  approved_by_user_id uuid NOT NULL REFERENCES identity.users(id),
  checked_by_user_id uuid NOT NULL REFERENCES identity.users(id),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  previous_brand_state text NOT NULL,
  resulting_brand_state text NOT NULL CHECK (resulting_brand_state IN ('approved','rejected')),
  membership_before text,
  membership_after text,
  response_payload jsonb NOT NULL CHECK (jsonb_typeof(response_payload)='object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (approved_by_user_id <> checked_by_user_id),
  CHECK (approved_by_user_id <> applicant_user_id),
  CHECK (checked_by_user_id <> applicant_user_id),
  CHECK ((decision='approved' AND resulting_brand_state='approved'
          AND membership_before IN ('pending','active') AND membership_after='active')
      OR (decision='rejected' AND resulting_brand_state='rejected'
          AND membership_after IS NULL))
);
--> statement-breakpoint

CREATE INDEX brand_catalog_eligibility_events_brand_time_idx
  ON brands.brand_catalog_eligibility_events(brand_id,occurred_at,event_id);
--> statement-breakpoint

CREATE FUNCTION brands.reject_brand_catalog_eligibility_event_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog, brands AS $$
BEGIN
  RAISE EXCEPTION 'BRAND_CATALOG_ELIGIBILITY_EVENT_IMMUTABLE' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER brand_catalog_eligibility_events_immutable
BEFORE UPDATE OR DELETE ON brands.brand_catalog_eligibility_events
FOR EACH ROW EXECUTE FUNCTION brands.reject_brand_catalog_eligibility_event_mutation();
