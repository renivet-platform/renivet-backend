-- REN2-77 adds immutable mapping revisions and complete frozen preview payloads.
-- Import catalog writes remain deferred to the explicit REN2-78 confirmation command.

CREATE TABLE imports.import_mapping_profiles (
  id uuid PRIMARY KEY,
  brand_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  profile_sha256 char(64) NOT NULL CHECK (profile_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  preview_revision bigint NOT NULL CHECK (preview_revision > 0),
  preview_hash char(64) NOT NULL CHECK (preview_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES identity.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (batch_id, brand_id) REFERENCES imports.import_batches(id, brand_id),
  UNIQUE (batch_id, version),
  UNIQUE (brand_id, idempotency_key)
);
--> statement-breakpoint

CREATE INDEX import_mapping_profiles_batch_version_idx
  ON imports.import_mapping_profiles(brand_id, batch_id, version DESC);
--> statement-breakpoint

CREATE TRIGGER import_mapping_profiles_immutable BEFORE UPDATE OR DELETE
ON imports.import_mapping_profiles FOR EACH ROW
EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

ALTER TABLE imports.import_previews
  ADD COLUMN preview_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(preview_snapshot) = 'object');
