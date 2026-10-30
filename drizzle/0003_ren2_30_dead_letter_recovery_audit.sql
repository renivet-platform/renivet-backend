CREATE TABLE "platform"."dead_letter_recovery_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_dead_letter_recovery_audit_reason_code_safe" CHECK ("platform"."dead_letter_recovery_audit"."reason_code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "platform"."dead_letter_recovery_audit" ADD CONSTRAINT "dead_letter_recovery_audit_case_id_dead_letter_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "platform"."dead_letter_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."dead_letter_recovery_audit" ADD CONSTRAINT "dead_letter_recovery_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_dead_letter_recovery_audit_case_idx" ON "platform"."dead_letter_recovery_audit" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE FUNCTION "platform"."reject_dead_letter_recovery_audit_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'dead-letter recovery audit is append-only'; END; $$;--> statement-breakpoint
CREATE TRIGGER "platform_dead_letter_recovery_audit_append_only" BEFORE UPDATE OR DELETE ON "platform"."dead_letter_recovery_audit" FOR EACH ROW EXECUTE FUNCTION "platform"."reject_dead_letter_recovery_audit_mutation"();
