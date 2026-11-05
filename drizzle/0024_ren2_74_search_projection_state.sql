-- REN2-74: monotonic PostgreSQL watermark for the derived Typesense product index.
-- W1 outbox/inbox remains the durable event and delivery authority.

CREATE TABLE catalogue.search_projection_state (
  product_id uuid PRIMARY KEY,
  brand_id uuid NOT NULL,
  publication_version bigint NOT NULL CHECK(publication_version>0),
  source_event_id uuid NOT NULL REFERENCES platform.outbox_events(id),
  source_event_publication_version bigint NOT NULL CHECK(source_event_publication_version>0),
  projection_schema_version integer NOT NULL CHECK(projection_schema_version=1),
  document_state text NOT NULL CHECK(document_state IN('PUBLISHED','TOMBSTONED')),
  projected_sha256 char(64) NOT NULL CHECK(projected_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product_id,brand_id) REFERENCES catalogue.products(id,brand_id),
  CHECK(source_event_publication_version<=publication_version)
);
--> statement-breakpoint

CREATE FUNCTION catalogue.guard_search_projection_monotonicity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
     OR NEW.publication_version<OLD.publication_version
     OR NEW.source_event_publication_version>NEW.publication_version
     OR NEW.projection_schema_version<>1 THEN
    RAISE EXCEPTION 'CATALOG_SEARCH_PROJECTION_VERSION_INVALID' USING ERRCODE='23514';
  END IF;
  IF NEW.publication_version=OLD.publication_version AND
     (NEW.document_state IS DISTINCT FROM OLD.document_state OR NEW.projected_sha256 IS DISTINCT FROM OLD.projected_sha256) THEN
    RAISE EXCEPTION 'CATALOG_SEARCH_PROJECTION_SAME_VERSION_MUTATION' USING ERRCODE='23514';
  END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END; $$;
--> statement-breakpoint

CREATE TRIGGER search_projection_state_monotonic
BEFORE UPDATE ON catalogue.search_projection_state FOR EACH ROW
EXECUTE FUNCTION catalogue.guard_search_projection_monotonicity();
--> statement-breakpoint

CREATE INDEX search_projection_brand_version_idx
  ON catalogue.search_projection_state(brand_id,publication_version,product_id);
