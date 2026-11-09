ALTER TABLE imports.import_confirmations
  ADD COLUMN response_payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(response_payload) = 'object');
--> statement-breakpoint

CREATE TRIGGER import_confirmations_immutable BEFORE UPDATE OR DELETE
ON imports.import_confirmations FOR EACH ROW
EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

INSERT INTO access.permissions (permission_code, resource, action, description)
VALUES ('imports.confirm', 'imports', 'confirm', 'Confirm a frozen, brand-scoped catalog import preview')
ON CONFLICT (permission_code) DO NOTHING;
