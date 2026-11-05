-- REN2-69: independent claim moderation, immutable decisions and listing recheck requests.
-- No role is granted catalog.review by this migration; W1 global assignments remain owner controlled.

INSERT INTO access.permissions (permission_code, resource, action, description)
VALUES ('catalog.review', 'catalog', 'review', 'Independently review sustainability claims and evidence')
ON CONFLICT (permission_code) DO NOTHING;
--> statement-breakpoint

ALTER TABLE catalogue.sustainability_claims
  ADD COLUMN submitted_by uuid,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN decision_reason_code text;
--> statement-breakpoint

UPDATE catalogue.sustainability_claims c
   SET submitted_by = r.submitted_by
  FROM catalogue.product_revisions r
 WHERE r.id = c.revision_id AND r.product_id = c.product_id AND r.brand_id = c.brand_id
   AND c.submitted_by IS NULL;
--> statement-breakpoint

ALTER TABLE catalogue.sustainability_claims
  ALTER COLUMN submitted_by SET NOT NULL,
  ADD CONSTRAINT ren2_69_claim_submitter_fk FOREIGN KEY (submitted_by) REFERENCES identity.users(id),
  ADD CONSTRAINT ren2_69_claim_decision_reason_nonblank CHECK (
    decision_reason_code IS NULL OR length(btrim(decision_reason_code)) BETWEEN 1 AND 100
  );
--> statement-breakpoint

ALTER TABLE catalogue.claim_review_events
  ADD COLUMN previous_state text,
  ADD COLUMN next_state text,
  ADD COLUMN claim_row_version bigint,
  ADD COLUMN reviewer_comment text,
  ADD CONSTRAINT ren2_69_claim_review_state_pair CHECK (
    (previous_state IS NULL AND next_state IS NULL AND claim_row_version IS NULL)
    OR (previous_state IN ('PENDING','VERIFIED','REJECTED','EXPIRED','REVOKED')
      AND next_state IN ('PENDING','VERIFIED','REJECTED','EXPIRED','REVOKED') AND claim_row_version > 0)
  );
--> statement-breakpoint

ALTER TABLE catalogue.claim_mutation_receipts
  DROP CONSTRAINT claim_mutation_receipts_operation_check,
  ADD CONSTRAINT ren2_69_claim_receipt_operation_check
    CHECK (operation IN ('proposeProductClaim', 'decideProductClaim'));
--> statement-breakpoint

CREATE FUNCTION catalogue.guard_claim_review_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.brand_id IS DISTINCT FROM OLD.brand_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
    OR NEW.claim_code IS DISTINCT FROM OLD.claim_code
    OR NEW.claim_text IS DISTINCT FROM OLD.claim_text
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by THEN
    RAISE EXCEPTION 'CLAIM_CONTENT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.claim_state NOT IN ('PENDING','VERIFIED')
    OR NEW.claim_state = OLD.claim_state
    OR NEW.claim_state NOT IN ('VERIFIED','REJECTED','EXPIRED','REVOKED')
    OR (OLD.claim_state = 'PENDING' AND NEW.claim_state = 'REVOKED')
    OR (OLD.claim_state = 'VERIFIED' AND NEW.claim_state = 'REJECTED')
    OR NEW.row_version <> OLD.row_version + 1
    OR NEW.reviewed_by IS NULL OR NEW.reviewed_by = OLD.submitted_by
    OR NEW.reviewed_at IS NULL
    OR NEW.decision_reason_code IS NULL OR length(btrim(NEW.decision_reason_code)) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'CLAIM_REVIEW_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.claim_state = 'VERIFIED' AND NEW.approved_at IS NULL THEN
    RAISE EXCEPTION 'CLAIM_APPROVAL_TIMESTAMP_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF NEW.claim_state = 'REJECTED' AND NEW.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'CLAIM_REJECTED_CANNOT_BE_APPROVED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER sustainability_claim_review_transition
BEFORE UPDATE ON catalogue.sustainability_claims
FOR EACH ROW EXECUTE FUNCTION catalogue.guard_claim_review_transition();
--> statement-breakpoint
