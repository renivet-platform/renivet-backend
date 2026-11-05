-- REN2-68: brand-scoped sustainability claim proposals and evidence lifecycle.
-- Moderation writes remain owned by REN2-69; no proposal path can self-verify.

INSERT INTO access.permissions (permission_code, resource, action, description)
VALUES ('catalog.write','catalog','write','Create and update brand-owned product drafts'),
       ('catalog.read','catalog','read','Read brand-owned catalogue resources')
ON CONFLICT (permission_code) DO NOTHING;
--> statement-breakpoint

ALTER TABLE catalogue.sustainability_claims
  ADD COLUMN row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0);
--> statement-breakpoint

ALTER TABLE catalogue.claim_evidence
  ADD COLUMN row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  ADD COLUMN recalled_at timestamptz,
  ADD COLUMN recall_reason_code text,
  ADD CONSTRAINT claim_evidence_recall_pair CHECK (
    (recalled_at IS NULL AND recall_reason_code IS NULL)
    OR (recalled_at IS NOT NULL AND length(btrim(recall_reason_code)) BETWEEN 1 AND 100)
  );
--> statement-breakpoint

CREATE INDEX sustainability_claim_product_history_idx
  ON catalogue.sustainability_claims (brand_id, product_id, created_at DESC, id);
--> statement-breakpoint

CREATE INDEX claim_evidence_claim_state_expiry_idx
  ON catalogue.claim_evidence (brand_id, product_id, claim_id, evidence_state, document_expires_at);
--> statement-breakpoint

CREATE TABLE catalogue.claim_mutation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  product_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  operation text NOT NULL CHECK (operation = 'proposeProductClaim'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  claim_id uuid NOT NULL,
  response_payload jsonb NOT NULL CHECK (jsonb_typeof(response_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, brand_id) REFERENCES catalogue.products(id, brand_id),
  FOREIGN KEY (claim_id, brand_id, product_id) REFERENCES catalogue.sustainability_claims(id, brand_id, product_id),
  UNIQUE (brand_id, actor_user_id, operation, idempotency_key)
);
--> statement-breakpoint

CREATE INDEX claim_mutation_receipts_claim_idx
  ON catalogue.claim_mutation_receipts (brand_id, product_id, claim_id);
--> statement-breakpoint

CREATE TRIGGER claim_mutation_receipts_immutable
BEFORE UPDATE OR DELETE ON catalogue.claim_mutation_receipts
FOR EACH ROW EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE TRIGGER claim_review_events_immutable
BEFORE UPDATE OR DELETE ON catalogue.claim_review_events
FOR EACH ROW EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE FUNCTION catalogue.guard_claim_evidence_asset()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM media.media_assets a
     WHERE a.id = NEW.media_asset_id AND a.brand_id = NEW.brand_id
       AND a.scan_state = 'CLEAN' AND a.derivative_state = 'READY'
       AND a.rights_state IN ('ATTESTED','REVIEWED')
  ) THEN
    RAISE EXCEPTION 'CLAIM_EVIDENCE_ASSET_NOT_READY' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER claim_evidence_asset_ready_guard
BEFORE INSERT OR UPDATE OF brand_id, media_asset_id ON catalogue.claim_evidence
FOR EACH ROW EXECUTE FUNCTION catalogue.guard_claim_evidence_asset();
