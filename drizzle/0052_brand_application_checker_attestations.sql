-- DEF-011: a reviewer must record a separate authenticated decision before a
-- different admin can finalize a brand application. IDs supplied by the maker
-- alone are never independent evidence.
CREATE TABLE brands.brand_application_checker_attestations (
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  applicant_user_id uuid NOT NULL REFERENCES identity.users(id),
  checker_user_id uuid NOT NULL REFERENCES identity.users(id),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (brand_id,checker_user_id),
  CHECK (applicant_user_id <> checker_user_id)
);
--> statement-breakpoint
CREATE FUNCTION brands.reject_checker_attestation_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog, brands AS $$
BEGIN
  RAISE EXCEPTION 'BRAND_CHECKER_ATTESTATION_IMMUTABLE' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER brand_checker_attestations_immutable
BEFORE UPDATE OR DELETE ON brands.brand_application_checker_attestations
FOR EACH ROW EXECUTE FUNCTION brands.reject_checker_attestation_mutation();
