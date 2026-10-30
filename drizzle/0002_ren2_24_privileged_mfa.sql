CREATE TABLE "identity"."mfa_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"user_id" uuid NOT NULL,
	"encrypted_secret" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"state" text NOT NULL,
	"pending_expires_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_totp_step" bigint,
	CONSTRAINT "identity_mfa_factors_state_valid" CHECK ("identity"."mfa_factors"."state" IN ('pending', 'active', 'revoked')),
	CONSTRAINT "identity_mfa_factors_secret_state_valid" CHECK (("identity"."mfa_factors"."state" = 'revoked' AND "identity"."mfa_factors"."encrypted_secret" = '' AND "identity"."mfa_factors"."secret_iv" = '' AND "identity"."mfa_factors"."secret_tag" = '') OR ("identity"."mfa_factors"."state" IN ('pending', 'active') AND "identity"."mfa_factors"."encrypted_secret" ~ '^[A-Za-z0-9+/]{27}=$' AND "identity"."mfa_factors"."secret_iv" ~ '^[A-Za-z0-9+/]{16}$' AND "identity"."mfa_factors"."secret_tag" ~ '^[A-Za-z0-9+/]{22}==$')),
	CONSTRAINT "identity_mfa_factors_lifecycle_valid" CHECK (("identity"."mfa_factors"."state" = 'pending' AND "identity"."mfa_factors"."pending_expires_at" > "identity"."mfa_factors"."created_at" AND "identity"."mfa_factors"."activated_at" IS NULL AND "identity"."mfa_factors"."revoked_at" IS NULL) OR ("identity"."mfa_factors"."state" = 'active' AND "identity"."mfa_factors"."activated_at" IS NOT NULL AND "identity"."mfa_factors"."revoked_at" IS NULL) OR ("identity"."mfa_factors"."state" = 'revoked' AND "identity"."mfa_factors"."revoked_at" IS NOT NULL)),
	CONSTRAINT "identity_mfa_factors_totp_step_nonnegative" CHECK ("identity"."mfa_factors"."last_totp_step" IS NULL OR "identity"."mfa_factors"."last_totp_step" >= 0),
	CONSTRAINT "identity_mfa_factors_row_version_positive" CHECK ("identity"."mfa_factors"."row_version" > 0),
	CONSTRAINT "identity_mfa_factors_timestamps_ordered" CHECK ("identity"."mfa_factors"."updated_at" >= "identity"."mfa_factors"."created_at")
);
--> statement-breakpoint
CREATE TABLE "identity"."mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"factor_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "identity_mfa_recovery_codes_hash_sha256" CHECK ("identity"."mfa_recovery_codes"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "identity_mfa_recovery_codes_consumed_after_creation" CHECK ("identity"."mfa_recovery_codes"."consumed_at" IS NULL OR "identity"."mfa_recovery_codes"."consumed_at" >= "identity"."mfa_recovery_codes"."created_at")
);
--> statement-breakpoint
CREATE TABLE "identity"."security_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"session_id" uuid,
	"factor_id" uuid,
	"event_name" text NOT NULL,
	"outcome" text NOT NULL,
	"ip_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "identity_security_audit_event_valid" CHECK ("identity"."security_audit_events"."event_name" IN ('enrollment_started', 'enrollment_activated', 'enrollment_denied', 'step_up_succeeded', 'step_up_denied', 'factor_revoked', 'privileged_access_allowed', 'privileged_access_denied')),
	CONSTRAINT "identity_security_audit_outcome_valid" CHECK ("identity"."security_audit_events"."outcome" IN ('allowed', 'denied')),
	CONSTRAINT "identity_security_audit_metadata_object" CHECK (jsonb_typeof("identity"."security_audit_events"."metadata") = 'object')
);
--> statement-breakpoint
ALTER TABLE "identity"."user_sessions" ADD COLUMN "absolute_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "identity"."user_sessions" SET "absolute_expires_at" = "created_at" + interval '7 days';--> statement-breakpoint
ALTER TABLE "identity"."user_sessions" ALTER COLUMN "absolute_expires_at" SET DEFAULT now() + interval '7 days';--> statement-breakpoint
ALTER TABLE "identity"."user_sessions" ALTER COLUMN "absolute_expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."user_sessions" ADD COLUMN "mfa_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity"."mfa_factors" ADD CONSTRAINT "mfa_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_factor_id_mfa_factors_id_fk" FOREIGN KEY ("factor_id") REFERENCES "identity"."mfa_factors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."security_audit_events" ADD CONSTRAINT "security_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."security_audit_events" ADD CONSTRAINT "security_audit_events_session_id_user_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "identity"."user_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."security_audit_events" ADD CONSTRAINT "security_audit_events_factor_id_mfa_factors_id_fk" FOREIGN KEY ("factor_id") REFERENCES "identity"."mfa_factors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_mfa_factors_one_pending_or_active_uq" ON "identity"."mfa_factors" USING btree ("user_id") WHERE "identity"."mfa_factors"."state" IN ('pending', 'active');--> statement-breakpoint
CREATE INDEX "identity_mfa_factors_user_created_idx" ON "identity"."mfa_factors" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_mfa_recovery_codes_factor_hash_uq" ON "identity"."mfa_recovery_codes" USING btree ("factor_id","code_hash");--> statement-breakpoint
CREATE INDEX "identity_mfa_recovery_codes_factor_consumed_idx" ON "identity"."mfa_recovery_codes" USING btree ("factor_id","consumed_at");--> statement-breakpoint
CREATE INDEX "identity_security_audit_user_created_idx" ON "identity"."security_audit_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "identity_security_audit_event_created_idx" ON "identity"."security_audit_events" USING btree ("event_name","created_at");--> statement-breakpoint
ALTER TABLE "identity"."user_sessions" ADD CONSTRAINT "identity_user_sessions_absolute_expiry_after_creation" CHECK ("identity"."user_sessions"."absolute_expires_at" > "identity"."user_sessions"."created_at");--> statement-breakpoint
ALTER TABLE "identity"."user_sessions" ADD CONSTRAINT "identity_user_sessions_idle_expiry_within_absolute" CHECK ("identity"."user_sessions"."expires_at" <= "identity"."user_sessions"."absolute_expires_at");
