-- REN2-56 adds database-enforced W2 v1.5 taxonomy lifecycle invariants.
-- This is additive over REN2-50's candidate W2 schema; it adds no seed rows or routes.
-- Apply only through the reviewed Drizzle chain to a disposable/authorized database.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM catalogue.categories c
      LEFT JOIN catalogue.category_schema_versions v
        ON v.category_id = c.id AND v.version = c.schema_version
     WHERE c.schema_version IS NOT NULL AND v.id IS NULL
  ) THEN
    RAISE EXCEPTION 'REN2-56 migration found a category pointer without a matching schema version';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM catalogue.categories c
      LEFT JOIN catalogue.category_schema_versions v
        ON v.category_id = c.id AND v.version = c.schema_version
     WHERE c.active AND (v.state IS DISTINCT FROM 'PUBLISHED'
       OR EXISTS (SELECT 1 FROM catalogue.categories child WHERE child.parent_id = c.id))
  ) THEN
    RAISE EXCEPTION 'REN2-56 migration found an active category without a published leaf schema';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM catalogue.product_revisions r
      JOIN catalogue.products p ON p.id = r.product_id AND p.brand_id = r.brand_id
     WHERE r.category_id IS DISTINCT FROM p.category_id
        OR r.category_schema_version IS DISTINCT FROM p.category_schema_version
  ) THEN
    RAISE EXCEPTION 'REN2-56 migration found a product revision with a mismatched category schema pin';
  END IF;
END;
$$;
--> statement-breakpoint

ALTER TABLE catalogue.categories ALTER COLUMN active SET DEFAULT false;
--> statement-breakpoint
ALTER TABLE catalogue.categories ALTER COLUMN schema_version DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE catalogue.categories ALTER COLUMN schema_version DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE catalogue.categories
  ADD CONSTRAINT categories_active_requires_schema_pointer
  CHECK (NOT active OR schema_version IS NOT NULL);
--> statement-breakpoint
ALTER TABLE catalogue.categories
  ADD CONSTRAINT categories_current_schema_version_fk
  FOREIGN KEY (id, schema_version)
  REFERENCES catalogue.category_schema_versions(category_id, version)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

ALTER TABLE catalogue.category_schema_versions
  ADD CONSTRAINT category_schema_versions_approved_by_user_fk
  FOREIGN KEY (approved_by) REFERENCES identity.users(id);
--> statement-breakpoint
ALTER TABLE catalogue.category_schema_versions
  ADD CONSTRAINT category_schema_versions_draft_has_no_approval
  CHECK (state <> 'DRAFT' OR (approved_by IS NULL AND published_at IS NULL));
--> statement-breakpoint

ALTER TABLE catalogue.product_revisions
  ADD CONSTRAINT product_revisions_exact_product_schema_fk
  FOREIGN KEY (product_id, brand_id, category_id, category_schema_version)
  REFERENCES catalogue.products (id, brand_id, category_id, category_schema_version);
--> statement-breakpoint

CREATE TABLE catalogue.category_availability_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES catalogue.categories(id),
  active_before boolean NOT NULL,
  active_after boolean NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (active_before IS DISTINCT FROM active_after)
);
--> statement-breakpoint
CREATE INDEX category_availability_events_category_time_idx
  ON catalogue.category_availability_events(category_id, occurred_at, id);
--> statement-breakpoint

CREATE FUNCTION catalogue.reject_category_availability_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CATEGORY_AVAILABILITY_EVENT_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER category_availability_events_immutable
BEFORE UPDATE OR DELETE ON catalogue.category_availability_events
FOR EACH ROW EXECUTE FUNCTION catalogue.reject_category_availability_event_mutation();
--> statement-breakpoint

-- One transaction lock serializes tree edits and schema publication. It is taken
-- at statement start, before PostgreSQL takes row locks, avoiding lock-order inversion.
CREATE FUNCTION catalogue.lock_taxonomy_writes()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(56056056::bigint);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER category_tree_write_lock
BEFORE INSERT OR UPDATE OR DELETE ON catalogue.categories
FOR EACH STATEMENT EXECUTE FUNCTION catalogue.lock_taxonomy_writes();
--> statement-breakpoint
CREATE TRIGGER category_schema_write_lock
BEFORE INSERT OR UPDATE OR DELETE ON catalogue.category_schema_versions
FOR EACH STATEMENT EXECUTE FUNCTION catalogue.lock_taxonomy_writes();
--> statement-breakpoint

CREATE FUNCTION catalogue.category_schema_content_sha256(
  p_schema_version_id uuid,
  p_ruleset jsonb,
  p_validator_version text
)
RETURNS char(64) LANGUAGE sql STABLE AS $$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'ruleset', p_ruleset,
          'validator_version', p_validator_version,
          'attribute_rules', COALESCE((
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'attribute_id', r.attribute_id,
                'attribute_code', r.attribute_code,
                'scope_type', r.scope_type,
                'value_type', r.value_type,
                'allowed_values', r.allowed_values,
                'unit_code', r.unit_code,
                'required_by_default', r.required_by_default,
                'conditional_ast', r.conditional_ast,
                'min_values', r.min_values,
                'max_values', r.max_values
              ) ORDER BY r.attribute_code, r.scope_type
            )
              FROM catalogue.category_schema_attribute_rules r
             WHERE r.schema_version_id = p_schema_version_id
          ), '[]'::jsonb)
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )::char(64);
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION catalogue.guard_category_schema_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_current_version integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'DRAFT' OR NEW.approved_by IS NOT NULL OR NEW.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'CATEGORY_SCHEMA_MUST_START_DRAFT' USING ERRCODE = '23514';
    END IF;
    NEW.ruleset_sha256 := catalogue.category_schema_content_sha256(
      NEW.id, NEW.ruleset, NEW.validator_version
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'DRAFT' THEN
      RAISE EXCEPTION 'PUBLISHED_SCHEMA_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.state <> 'DRAFT' THEN
    RAISE EXCEPTION 'PUBLISHED_SCHEMA_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.category_id <> OLD.category_id OR NEW.version <> OLD.version OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'SCHEMA_IDENTITY_CHANGE_FORBIDDEN' USING ERRCODE = '23514';
  END IF;
  IF NEW.state NOT IN ('DRAFT', 'PUBLISHED') THEN
    RAISE EXCEPTION 'INVALID_SCHEMA_TRANSITION' USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'DRAFT' THEN
    IF NEW.approved_by IS NOT NULL OR NEW.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'DRAFT_SCHEMA_CANNOT_HAVE_APPROVAL' USING ERRCODE = '23514';
    END IF;
    NEW.ruleset_sha256 := catalogue.category_schema_content_sha256(
      NEW.id, NEW.ruleset, NEW.validator_version
    );
    RETURN NEW;
  END IF;

  SELECT c.schema_version
    INTO v_current_version
    FROM catalogue.categories c
   WHERE c.id = NEW.category_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CATEGORY_SCHEMA_CATEGORY_MISSING' USING ERRCODE = '23503';
  END IF;
  IF v_current_version IS NOT NULL AND NEW.version < v_current_version THEN
    RAISE EXCEPTION 'CATEGORY_SCHEMA_VERSION_ROLLBACK' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM catalogue.categories child WHERE child.parent_id = NEW.category_id) THEN
    RAISE EXCEPTION 'CATEGORY_SCHEMA_NON_LEAF_PUBLISH_FORBIDDEN' USING ERRCODE = '23514';
  END IF;
  IF NEW.approved_by IS NULL THEN
    RAISE EXCEPTION 'CATEGORY_SCHEMA_APPROVER_REQUIRED' USING ERRCODE = '23514';
  END IF;

  NEW.published_at := COALESCE(NEW.published_at, pg_catalog.clock_timestamp());
  NEW.ruleset_sha256 := catalogue.category_schema_content_sha256(
    NEW.id, NEW.ruleset, NEW.validator_version
  );
  UPDATE catalogue.categories
     SET schema_version = NEW.version,
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = NEW.category_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER category_schema_lifecycle_guard ON catalogue.category_schema_versions;
--> statement-breakpoint
CREATE TRIGGER category_schema_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON catalogue.category_schema_versions
FOR EACH ROW EXECUTE FUNCTION catalogue.guard_category_schema_version();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION catalogue.guard_category_node()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_actor_text text;
  v_request_id text;
  v_reason_code text;
  v_actor_user_id uuid;
  v_is_cycle boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CATEGORY_DELETE_FORBIDDEN_USE_RETIREMENT' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.active THEN
    RAISE EXCEPTION 'CATEGORY_MUST_START_INACTIVE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.code <> OLD.code THEN
      RAISE EXCEPTION 'CATEGORY_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF OLD.schema_version IS NOT NULL
       AND (NEW.schema_version IS NULL OR NEW.schema_version < OLD.schema_version) THEN
      RAISE EXCEPTION 'CATEGORY_SCHEMA_VERSION_ROLLBACK' USING ERRCODE = '23514';
    END IF;
    IF NEW.parent_id IS DISTINCT FROM OLD.parent_id
       AND EXISTS (
         SELECT 1 FROM catalogue.category_schema_versions v
          WHERE v.category_id = OLD.id AND v.state = 'PUBLISHED'
       ) THEN
      RAISE EXCEPTION 'PUBLISHED_CATEGORY_PARENT_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id THEN
      RAISE EXCEPTION 'CATEGORY_TREE_CYCLE' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM catalogue.category_schema_versions v
       WHERE v.category_id = NEW.parent_id AND v.state = 'PUBLISHED'
    ) THEN
      RAISE EXCEPTION 'PUBLISHED_CATEGORY_CANNOT_GAIN_CHILDREN' USING ERRCODE = '23514';
    END IF;
    WITH RECURSIVE ancestors(id, parent_id, visited) AS (
      SELECT c.id, c.parent_id, ARRAY[c.id]::uuid[]
        FROM catalogue.categories c WHERE c.id = NEW.parent_id
      UNION ALL
      SELECT p.id, p.parent_id, a.visited || p.id
        FROM catalogue.categories p
        JOIN ancestors a ON p.id = a.parent_id
       WHERE NOT p.id = ANY(a.visited)
    )
    SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id) INTO v_is_cycle;
    IF v_is_cycle THEN
      RAISE EXCEPTION 'CATEGORY_TREE_CYCLE' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.active IS DISTINCT FROM OLD.active THEN
    v_actor_text := NULLIF(pg_catalog.current_setting('app.taxonomy_actor_user_id', true), '');
    v_request_id := NULLIF(pg_catalog.current_setting('app.taxonomy_request_id', true), '');
    v_reason_code := NULLIF(pg_catalog.current_setting('app.taxonomy_reason_code', true), '');
    IF v_actor_text IS NULL
       OR v_actor_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR v_request_id IS NULL OR v_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
       OR v_reason_code IS NULL OR v_reason_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
      RAISE EXCEPTION 'CATEGORY_AVAILABILITY_AUDIT_CONTEXT_REQUIRED' USING ERRCODE = '42501';
    END IF;
    v_actor_user_id := v_actor_text::uuid;
    INSERT INTO catalogue.category_availability_events
      (category_id, active_before, active_after, actor_user_id, request_id, reason_code)
    VALUES (OLD.id, OLD.active, NEW.active, v_actor_user_id, v_request_id, v_reason_code);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER category_node_guard
BEFORE INSERT OR UPDATE OR DELETE ON catalogue.categories
FOR EACH ROW EXECUTE FUNCTION catalogue.guard_category_node();
--> statement-breakpoint

CREATE FUNCTION catalogue.guard_category_current_schema_pointer()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
BEGIN
  IF NEW.schema_version IS NULL THEN
    IF NEW.active THEN
      RAISE EXCEPTION 'ACTIVE_CATEGORY_REQUIRES_PUBLISHED_SCHEMA' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT v.state INTO v_state
    FROM catalogue.category_schema_versions v
   WHERE v.category_id = NEW.id AND v.version = NEW.schema_version;
  IF v_state IS DISTINCT FROM 'PUBLISHED' THEN
    RAISE EXCEPTION 'CATEGORY_CURRENT_SCHEMA_MUST_BE_PUBLISHED' USING ERRCODE = '23514';
  END IF;
  IF NEW.active AND EXISTS (
    SELECT 1 FROM catalogue.categories child WHERE child.parent_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'ACTIVE_CATEGORY_MUST_BE_LEAF' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER category_current_schema_pointer_guard
AFTER INSERT OR UPDATE ON catalogue.categories
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION catalogue.guard_category_current_schema_pointer();
