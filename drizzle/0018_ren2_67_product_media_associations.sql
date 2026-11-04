-- REN2-67: versioned brand-owned product/variant media links and immutable audit.
-- Published revisions remain frozen; detaching only closes the active association.

ALTER TABLE media.product_media
  DROP CONSTRAINT product_media_brand_id_product_id_variant_id_display_order_key,
  ADD COLUMN detached_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT product_media_role_valid CHECK (length(btrim(display_role)) BETWEEN 1 AND 64),
  ADD CONSTRAINT product_media_alt_text_valid CHECK (length(alt_text) <= 500),
  ADD CONSTRAINT product_media_id_brand_uq UNIQUE (id,brand_id);
--> statement-breakpoint

DROP INDEX media.product_media_parent_order_uq;
--> statement-breakpoint

CREATE UNIQUE INDEX product_media_parent_order_active_uq
  ON media.product_media(brand_id,product_id,display_order)
  WHERE variant_id IS NULL AND detached_at IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX product_media_variant_order_active_uq
  ON media.product_media(brand_id,product_id,variant_id,display_order)
  WHERE variant_id IS NOT NULL AND detached_at IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX product_media_parent_asset_active_uq
  ON media.product_media(brand_id,product_id,media_asset_id)
  WHERE variant_id IS NULL AND detached_at IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX product_media_variant_asset_active_uq
  ON media.product_media(brand_id,product_id,variant_id,media_asset_id)
  WHERE variant_id IS NOT NULL AND detached_at IS NULL;
--> statement-breakpoint

CREATE INDEX product_media_product_active_idx
  ON media.product_media(brand_id,product_id,variant_id,display_order,id)
  WHERE detached_at IS NULL;
--> statement-breakpoint

ALTER TABLE catalogue.product_mutation_receipts
  DROP CONSTRAINT product_mutation_receipts_operation_check,
  ADD CONSTRAINT product_mutation_receipts_operation_check CHECK (operation IN (
    'createBrandProduct','updateBrandProduct','createProductVariant','updateProductVariant','deactivateProductVariant',
    'attachProductMedia','updateProductMediaLink','detachProductMedia'
  ));
--> statement-breakpoint

CREATE TABLE media.product_media_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_media_id uuid NOT NULL,
  media_asset_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256),
  event_name text NOT NULL CHECK (event_name IN ('attachProductMedia','updateProductMediaLink','detachProductMedia')),
  before_snapshot jsonb,
  after_snapshot jsonb NOT NULL CHECK (jsonb_typeof(after_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id,brand_id) REFERENCES catalogue.products(id,brand_id),
  FOREIGN KEY (product_media_id,brand_id) REFERENCES media.product_media(id,brand_id),
  FOREIGN KEY (media_asset_id,brand_id) REFERENCES media.media_assets(id,brand_id)
);
--> statement-breakpoint

CREATE INDEX product_media_audit_product_created_idx
  ON media.product_media_audit_events(brand_id,product_id,created_at,id);
--> statement-breakpoint

CREATE TRIGGER product_media_audit_events_immutable
BEFORE UPDATE OR DELETE ON media.product_media_audit_events
FOR EACH ROW EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE FUNCTION media.guard_active_product_media_asset()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.detached_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM media.media_assets a
     WHERE a.id=NEW.media_asset_id AND a.brand_id=NEW.brand_id
       AND a.scan_state='CLEAN' AND a.derivative_state='READY'
       AND a.rights_state IN ('ATTESTED','REVIEWED')
  ) THEN
    RAISE EXCEPTION 'PRODUCT_MEDIA_ASSET_NOT_READY' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER product_media_asset_ready_guard
BEFORE INSERT OR UPDATE OF brand_id,product_id,variant_id,media_asset_id,detached_at
ON media.product_media FOR EACH ROW EXECUTE FUNCTION media.guard_active_product_media_asset();
--> statement-breakpoint

CREATE FUNCTION catalogue.guard_product_media_publication()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.publication_state='PUBLISHED'
    AND (OLD.publication_state IS DISTINCT FROM NEW.publication_state
      OR OLD.published_revision_id IS DISTINCT FROM NEW.published_revision_id)
    AND EXISTS (
      SELECT 1 FROM media.product_media pm
      JOIN media.media_assets a ON a.id=pm.media_asset_id AND a.brand_id=pm.brand_id
       WHERE pm.brand_id=NEW.brand_id AND pm.product_id=NEW.id AND pm.detached_at IS NULL
         AND (a.scan_state<>'CLEAN' OR a.derivative_state<>'READY' OR a.rights_state NOT IN ('ATTESTED','REVIEWED'))
    ) THEN
    RAISE EXCEPTION 'PRODUCT_MEDIA_ASSET_NOT_READY' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER product_media_publication_ready_guard
BEFORE UPDATE OF publication_state,published_revision_id ON catalogue.products
FOR EACH ROW EXECUTE FUNCTION catalogue.guard_product_media_publication();
--> statement-breakpoint

INSERT INTO access.permissions(permission_code,resource,action,description)
VALUES ('catalog.write','catalog','write','Create and update brand-owned product drafts')
ON CONFLICT (permission_code) DO NOTHING;
