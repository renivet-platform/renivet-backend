ALTER TABLE catalogue.category_schema_attribute_rules
  ADD COLUMN display_label text;
--> statement-breakpoint

UPDATE catalogue.category_schema_attribute_rules r
   SET display_label = a.label
  FROM catalogue.attributes a
 WHERE a.id = r.attribute_id;
--> statement-breakpoint

ALTER TABLE catalogue.category_schema_attribute_rules
  ALTER COLUMN display_label SET NOT NULL,
  ALTER COLUMN display_label SET DEFAULT '';
--> statement-breakpoint

CREATE FUNCTION catalogue.snapshot_category_attribute_display_label()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.display_label = '' THEN
    SELECT label INTO NEW.display_label FROM catalogue.attributes WHERE id = NEW.attribute_id;
  END IF;
  IF NEW.display_label IS NULL OR NEW.display_label = '' THEN
    RAISE EXCEPTION 'CATEGORY_SCHEMA_ATTRIBUTE_LABEL_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER category_schema_rule_display_label
BEFORE INSERT ON catalogue.category_schema_attribute_rules
FOR EACH ROW EXECUTE FUNCTION catalogue.snapshot_category_attribute_display_label();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION catalogue.category_schema_content_sha256(
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
                'display_label', r.display_label,
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

-- Recompute historical hashes after the labels have been backfilled. Restore
-- the published-schema guard before this atomic migration commits.
DROP TRIGGER category_schema_lifecycle_guard ON catalogue.category_schema_versions;
--> statement-breakpoint

UPDATE catalogue.category_schema_versions
   SET ruleset_sha256 = catalogue.category_schema_content_sha256(id, ruleset, validator_version);
--> statement-breakpoint

CREATE TRIGGER category_schema_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON catalogue.category_schema_versions
FOR EACH ROW EXECUTE FUNCTION catalogue.guard_category_schema_version();
