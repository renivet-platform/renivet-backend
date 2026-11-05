-- REN2-72: exact-revision maker-checker decisions, audit history and retry receipts.
-- catalog.review remains globally assigned only by owner-controlled W1 access setup.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM catalogue.product_qc_reviews GROUP BY revision_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'REN2-72 cannot enforce one decision per revision: duplicate review history exists';
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX product_qc_reviews_one_decision_per_revision
  ON catalogue.product_qc_reviews(revision_id);
--> statement-breakpoint

ALTER TABLE catalogue.product_qc_reviews
  ADD CONSTRAINT product_qc_reviews_reason_nonblank CHECK(length(btrim(reason_code)) BETWEEN 2 AND 64),
  ADD CONSTRAINT product_qc_reviews_reviewer_fk FOREIGN KEY(reviewer_user_id) REFERENCES identity.users(id);
--> statement-breakpoint

CREATE FUNCTION catalogue.guard_product_qc_review_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submitted_by_user uuid; revision_state text;
BEGIN
  SELECT r.submitted_by,r.review_state INTO submitted_by_user,revision_state
    FROM catalogue.product_revisions r
   WHERE r.id=NEW.revision_id AND r.product_id=NEW.product_id AND r.brand_id=NEW.brand_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- let the composite FK reject a cross-product or cross-brand reference
  IF revision_state IS DISTINCT FROM 'SUBMITTED' AND revision_state IS DISTINCT FROM NEW.decision THEN
    RAISE EXCEPTION 'CATALOG_REVIEW_DECISION_INVALID' USING ERRCODE='23514';
  END IF;
  IF submitted_by_user=NEW.reviewer_user_id THEN
    RAISE EXCEPTION 'CATALOG_REVIEW_DECISION_INVALID' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM brands.brands b WHERE b.id=NEW.brand_id AND b.onboarding_state='approved')
    OR NOT EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=NEW.reviewer_user_id
      AND ep.permission_code='catalog.review' AND ep.scope_type='global' AND ep.brand_id IS NULL) THEN
    RAISE EXCEPTION 'CATALOG_REVIEW_ACCESS_DENIED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint

CREATE TRIGGER product_qc_review_authorization_guard
BEFORE INSERT ON catalogue.product_qc_reviews FOR EACH ROW
EXECUTE FUNCTION catalogue.guard_product_qc_review_insert();
--> statement-breakpoint

ALTER TABLE catalogue.product_revisions DROP CONSTRAINT product_revisions_review_state_check;
ALTER TABLE catalogue.product_revisions ADD CONSTRAINT product_revisions_review_state_check
  CHECK(review_state IN('DRAFT','SUBMITTED','APPROVED','REJECTED','CORRECTION_REQUIRED','RESTRICTED','SUPERSEDED'));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION catalogue.guard_product_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_PRODUCT_REVISION'; END IF;
  IF NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
     OR NEW.content_version IS DISTINCT FROM OLD.content_version
     OR NEW.content_snapshot IS DISTINCT FROM OLD.content_snapshot
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.category_schema_version IS DISTINCT FROM OLD.category_schema_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'PRODUCT_REVISION_CONTENT_IMMUTABLE';
  END IF;
  IF OLD.review_state='DRAFT' AND NEW.review_state IN('DRAFT','SUBMITTED') THEN RETURN NEW; END IF;
  IF OLD.review_state='SUBMITTED' AND NEW.review_state IN('APPROVED','REJECTED','CORRECTION_REQUIRED','RESTRICTED') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'INVALID_REVISION_TRANSITION';
END; $$;
--> statement-breakpoint

CREATE TABLE catalogue.product_qc_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  product_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  reviewer_user_id uuid NOT NULL REFERENCES identity.users(id),
  decision text NOT NULL CHECK(decision IN('APPROVED','REJECTED','CORRECTION_REQUIRED','RESTRICTED')),
  reason_code text NOT NULL CHECK(length(btrim(reason_code)) BETWEEN 2 AND 64),
  previous_review_state text NOT NULL CHECK(previous_review_state='SUBMITTED'),
  next_review_state text NOT NULL CHECK(next_review_state IN('APPROVED','REJECTED','CORRECTION_REQUIRED','RESTRICTED')),
  product_row_version bigint NOT NULL CHECK(product_row_version>0),
  reviewer_comment text NULL CHECK(reviewer_comment IS NULL OR length(reviewer_comment)<=2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product_id,brand_id) REFERENCES catalogue.products(id,brand_id),
  FOREIGN KEY(decision_id,revision_id,product_id,brand_id,decision)
    REFERENCES catalogue.product_qc_reviews(id,revision_id,product_id,brand_id,decision),
  UNIQUE(decision_id)
);
--> statement-breakpoint

CREATE TRIGGER product_qc_review_events_immutable BEFORE UPDATE OR DELETE
ON catalogue.product_qc_review_events FOR EACH ROW
EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE TABLE catalogue.product_review_decision_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  product_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 120),
  request_sha256 char(64) NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK(decision IN('APPROVED','REJECTED','CORRECTION_REQUIRED','RESTRICTED')),
  decision_id uuid NOT NULL UNIQUE,
  response_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product_id,brand_id) REFERENCES catalogue.products(id,brand_id),
  FOREIGN KEY(revision_id,product_id,brand_id) REFERENCES catalogue.product_revisions(id,product_id,brand_id),
  FOREIGN KEY(decision_id,revision_id,product_id,brand_id,decision)
    REFERENCES catalogue.product_qc_reviews(id,revision_id,product_id,brand_id,decision),
  UNIQUE(brand_id,product_id,actor_user_id,idempotency_key)
);
--> statement-breakpoint

CREATE TRIGGER product_review_decision_receipts_immutable BEFORE UPDATE OR DELETE
ON catalogue.product_review_decision_receipts FOR EACH ROW
EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE FUNCTION catalogue.require_complete_product_review_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.review_state='SUBMITTED' AND NEW.review_state IN('APPROVED','REJECTED','CORRECTION_REQUIRED','RESTRICTED') THEN
    IF NOT EXISTS(SELECT 1 FROM catalogue.product_qc_reviews q WHERE q.revision_id=NEW.id
        AND q.product_id=NEW.product_id AND q.brand_id=NEW.brand_id AND q.decision=NEW.review_state
        AND q.reviewer_user_id<>NEW.submitted_by)
      OR NOT EXISTS(SELECT 1 FROM catalogue.product_qc_review_events e JOIN catalogue.product_qc_reviews q
        ON q.id=e.decision_id WHERE q.revision_id=NEW.id AND e.revision_id=NEW.id
          AND e.product_id=NEW.product_id AND e.brand_id=NEW.brand_id AND e.decision=NEW.review_state)
      OR NOT EXISTS(SELECT 1 FROM catalogue.product_review_decision_receipts r JOIN catalogue.product_qc_reviews q
        ON q.id=r.decision_id WHERE q.revision_id=NEW.id AND r.revision_id=NEW.id
          AND r.product_id=NEW.product_id AND r.brand_id=NEW.brand_id AND r.decision=NEW.review_state) THEN
      RAISE EXCEPTION 'CATALOG_REVIEW_ATOMIC_RECORDS_REQUIRED' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END; $$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER product_revision_review_atomicity
AFTER UPDATE OF review_state ON catalogue.product_revisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION catalogue.require_complete_product_review_transition();
