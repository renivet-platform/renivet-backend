-- REN2-73: versioned product publication, restriction/unpublish history and W1 outbox atomicity.
-- No role grants are created here; W1 catalog.publish/catalog.restrict assignments remain owner controlled.

INSERT INTO access.permissions(permission_code,resource,action,description)
VALUES ('catalog.publish','catalog','publish','Publish an exact independently approved catalog revision'),
       ('catalog.restrict','catalog','restrict','Restrict or unpublish a published catalog product')
ON CONFLICT(permission_code) DO NOTHING;
--> statement-breakpoint

ALTER TABLE catalogue.publication_events
  ADD COLUMN actor_user_id uuid REFERENCES identity.users(id),
  ADD COLUMN reason_code text,
  ADD COLUMN appeal_reference text,
  ADD COLUMN comment text,
  ADD CONSTRAINT publication_event_reason_valid CHECK(reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  ADD CONSTRAINT publication_event_appeal_length CHECK(appeal_reference IS NULL OR length(appeal_reference)<=256),
  ADD CONSTRAINT publication_event_comment_length CHECK(comment IS NULL OR length(comment)<=2000);
--> statement-breakpoint

CREATE TABLE catalogue.publication_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  product_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  operation text NOT NULL CHECK(operation IN('PUBLISH','RESTRICT','UNPUBLISH')),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 120),
  request_sha256 char(64) NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
  publication_event_id uuid NOT NULL REFERENCES catalogue.publication_events(event_id),
  response_payload jsonb NOT NULL CHECK(jsonb_typeof(response_payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product_id,brand_id) REFERENCES catalogue.products(id,brand_id),
  UNIQUE(brand_id,product_id,actor_user_id,operation,idempotency_key)
);
--> statement-breakpoint

CREATE TRIGGER publication_command_receipts_immutable BEFORE UPDATE OR DELETE
ON catalogue.publication_command_receipts FOR EACH ROW
EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE FUNCTION catalogue.guard_publication_event_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE required_permission text; expected_state text;
BEGIN
  required_permission := CASE WHEN NEW.lifecycle_event='PUBLISH' THEN 'catalog.publish' ELSE 'catalog.restrict' END;
  expected_state := CASE NEW.lifecycle_event
    WHEN 'PUBLISH' THEN 'PUBLISHED' WHEN 'RESTRICT' THEN 'RESTRICTED'
    WHEN 'UNPUBLISH' THEN 'APPROVED' WHEN 'ARCHIVE' THEN 'ARCHIVED' END;
  IF NOT EXISTS(SELECT 1 FROM brands.brands b WHERE b.id=NEW.brand_id AND b.onboarding_state='approved')
    OR NOT EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=NEW.actor_user_id
      AND ep.permission_code=required_permission
      AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=NEW.brand_id))) THEN
    RAISE EXCEPTION 'CATALOG_PUBLICATION_ACCESS_DENIED' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM catalogue.products p WHERE p.id=NEW.product_id AND p.brand_id=NEW.brand_id
      AND p.publication_state=expected_state AND p.publication_version=NEW.publication_version
      AND p.content_version=NEW.content_version
      AND p.published_revision_id IS NOT DISTINCT FROM NEW.revision_id
      AND p.published_approval_id IS NOT DISTINCT FROM NEW.approved_review_id
      AND p.published_approval_decision IS NOT DISTINCT FROM NEW.approved_decision) THEN
    RAISE EXCEPTION 'CATALOG_PUBLICATION_EVENT_STATE_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF NEW.lifecycle_event='PUBLISH' AND NOT EXISTS(
    SELECT 1 FROM catalogue.product_revisions r JOIN catalogue.product_qc_reviews q
      ON q.revision_id=r.id AND q.product_id=r.product_id AND q.brand_id=r.brand_id
     WHERE r.id=NEW.revision_id AND r.product_id=NEW.product_id AND r.brand_id=NEW.brand_id
       AND r.review_state='APPROVED' AND r.content_version=NEW.content_version
       AND q.id=NEW.approved_review_id AND q.decision='APPROVED' AND q.reviewer_user_id<>r.submitted_by) THEN
    RAISE EXCEPTION 'CATALOG_PUBLICATION_APPROVAL_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint

CREATE TRIGGER publication_event_authorization_guard
BEFORE INSERT ON catalogue.publication_events FOR EACH ROW
EXECUTE FUNCTION catalogue.guard_publication_event_insert();
--> statement-breakpoint

CREATE FUNCTION catalogue.guard_product_publication_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.publication_version<>OLD.publication_version THEN
    IF NEW.publication_version<>OLD.publication_version+1 OR NOT (
      (NEW.publication_state='PUBLISHED' AND OLD.publication_state='APPROVED') OR
      (NEW.publication_state='RESTRICTED' AND OLD.publication_state='PUBLISHED') OR
      (NEW.publication_state='APPROVED' AND OLD.publication_state IN('PUBLISHED','RESTRICTED'))) THEN
      RAISE EXCEPTION 'CATALOG_PUBLICATION_TRANSITION_INVALID' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint

CREATE TRIGGER product_publication_transition_guard
BEFORE UPDATE OF publication_state,publication_version,published_revision_id,published_approval_id,published_approval_decision
ON catalogue.products FOR EACH ROW
EXECUTE FUNCTION catalogue.guard_product_publication_transition();
--> statement-breakpoint

CREATE FUNCTION catalogue.require_atomic_publication_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lifecycle text; event_id_value uuid; expected_type text;
BEGIN
  IF NEW.publication_version=OLD.publication_version THEN RETURN NULL; END IF;
  lifecycle := CASE
    WHEN NEW.publication_state='PUBLISHED' THEN 'PUBLISH'
    WHEN NEW.publication_state='RESTRICTED' THEN 'RESTRICT'
    WHEN OLD.publication_state IN('PUBLISHED','RESTRICTED') AND NEW.publication_state='APPROVED' THEN 'UNPUBLISH'
    ELSE NULL END;
  expected_type := CASE lifecycle
    WHEN 'PUBLISH' THEN 'catalogue.product.published'
    WHEN 'RESTRICT' THEN 'catalogue.product.restricted'
    WHEN 'UNPUBLISH' THEN 'catalogue.product.unpublished' END;
  SELECT e.event_id INTO event_id_value FROM catalogue.publication_events e
   WHERE e.brand_id=NEW.brand_id AND e.product_id=NEW.id AND e.publication_version=NEW.publication_version
     AND e.lifecycle_event=lifecycle;
  IF lifecycle IS NULL OR event_id_value IS NULL OR NOT EXISTS(
    SELECT 1 FROM catalogue.publication_events e
      JOIN platform.outbox_events o ON o.id=e.event_id
      JOIN catalogue.product_revisions r ON r.id=e.revision_id AND r.product_id=e.product_id AND r.brand_id=e.brand_id
     WHERE e.event_id=event_id_value AND e.brand_id=NEW.brand_id AND e.product_id=NEW.id
       AND e.publication_version=NEW.publication_version AND e.lifecycle_event=lifecycle
       AND o.aggregate_type='catalogue.product' AND o.aggregate_id=NEW.id AND o.event_type=expected_type AND o.event_version=1
       AND o.event_key=format('catalogue-publication:%s:%s',NEW.id,NEW.publication_version)
       AND o.event_payload->>'eventId'=e.event_id::text AND o.event_payload->>'brandId'=NEW.brand_id::text
       AND o.event_payload->>'productId'=NEW.id::text AND o.event_payload->>'revisionId'=e.revision_id::text
       AND o.event_payload->>'reviewId'=e.approved_review_id::text
       AND o.event_payload->>'publicationVersion'=e.publication_version::text
       AND o.event_payload->>'contentVersion'=e.content_version::text
       AND o.event_payload->>'contentSha256'=r.content_sha256::text
       AND o.event_payload->>'payloadSha256'=e.payload_sha256
       AND o.event_payload->>'publicationState'=NEW.publication_state)
    OR NOT EXISTS(SELECT 1 FROM catalogue.publication_command_receipts r
      WHERE r.publication_event_id=event_id_value AND r.brand_id=NEW.brand_id AND r.product_id=NEW.id
        AND r.operation=lifecycle) THEN
    RAISE EXCEPTION 'CATALOG_PUBLICATION_ATOMIC_RECORDS_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER product_publication_atomicity
AFTER UPDATE OF publication_version ON catalogue.products
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION catalogue.require_atomic_publication_command();
