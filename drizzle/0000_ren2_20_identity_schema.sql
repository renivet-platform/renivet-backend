CREATE SCHEMA "identity";
--> statement-breakpoint
CREATE TABLE "identity"."auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempt_count" integer NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "identity_auth_challenges_kind_not_blank" CHECK (length(btrim("identity"."auth_challenges"."kind")) > 0),
	CONSTRAINT "identity_auth_challenges_code_hash_hmac_sha256" CHECK ("identity"."auth_challenges"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "identity_auth_challenges_attempt_count_nonnegative" CHECK ("identity"."auth_challenges"."attempt_count" >= 0),
	CONSTRAINT "identity_auth_challenges_expiry_after_creation" CHECK ("identity"."auth_challenges"."expires_at" > "identity"."auth_challenges"."created_at"),
	CONSTRAINT "identity_auth_challenges_consumed_after_creation" CHECK ("identity"."auth_challenges"."consumed_at" is null or "identity"."auth_challenges"."consumed_at" >= "identity"."auth_challenges"."created_at"),
	CONSTRAINT "identity_auth_challenges_row_version_positive" CHECK ("identity"."auth_challenges"."row_version" > 0),
	CONSTRAINT "identity_auth_challenges_timestamps_ordered" CHECK ("identity"."auth_challenges"."updated_at" >= "identity"."auth_challenges"."created_at")
);
--> statement-breakpoint
CREATE TABLE "identity"."user_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"user_id" uuid NOT NULL,
	"password_hash" text NOT NULL,
	"credential_version" integer NOT NULL,
	"rotated_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "identity_user_credentials_argon2id_hash" CHECK ("identity"."user_credentials"."password_hash" ~ '^\$argon2id\$v=[0-9]+\$m=[1-9][0-9]*,t=[1-9][0-9]*,p=[1-9][0-9]*\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$'),
	CONSTRAINT "identity_user_credentials_version_positive" CHECK ("identity"."user_credentials"."credential_version" > 0),
	CONSTRAINT "identity_user_credentials_row_version_positive" CHECK ("identity"."user_credentials"."row_version" > 0),
	CONSTRAINT "identity_user_credentials_timestamps_ordered" CHECK ("identity"."user_credentials"."updated_at" >= "identity"."user_credentials"."created_at"),
	CONSTRAINT "identity_user_credentials_rotation_after_creation" CHECK ("identity"."user_credentials"."rotated_at" is null or "identity"."user_credentials"."rotated_at" >= "identity"."user_credentials"."created_at"),
	CONSTRAINT "identity_user_credentials_disable_after_creation" CHECK ("identity"."user_credentials"."disabled_at" is null or "identity"."user_credentials"."disabled_at" >= "identity"."user_credentials"."created_at")
);
--> statement-breakpoint
CREATE TABLE "identity"."user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_hash" text,
	CONSTRAINT "identity_user_sessions_token_hash_sha256" CHECK ("identity"."user_sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "identity_user_sessions_expiry_after_creation" CHECK ("identity"."user_sessions"."expires_at" > "identity"."user_sessions"."created_at"),
	CONSTRAINT "identity_user_sessions_revocation_after_creation" CHECK ("identity"."user_sessions"."revoked_at" is null or "identity"."user_sessions"."revoked_at" >= "identity"."user_sessions"."created_at"),
	CONSTRAINT "identity_user_sessions_row_version_positive" CHECK ("identity"."user_sessions"."row_version" > 0),
	CONSTRAINT "identity_user_sessions_timestamps_ordered" CHECK ("identity"."user_sessions"."updated_at" >= "identity"."user_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "identity"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"email" text,
	"phone" text,
	"display_name" text,
	"state" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"phone_verified_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "identity_users_state_not_blank" CHECK (length(btrim("identity"."users"."state")) > 0),
	CONSTRAINT "identity_users_email_not_blank" CHECK ("identity"."users"."email" is null or length(btrim("identity"."users"."email")) > 0),
	CONSTRAINT "identity_users_email_canonical" CHECK ("identity"."users"."email" is null or "identity"."users"."email" = lower(btrim("identity"."users"."email"))),
	CONSTRAINT "identity_users_phone_e164" CHECK ("identity"."users"."phone" is null or "identity"."users"."phone" ~ '^\+[1-9][0-9]{0,14}$'),
	CONSTRAINT "identity_users_email_verified_requires_email" CHECK ("identity"."users"."email_verified_at" is null or "identity"."users"."email" is not null),
	CONSTRAINT "identity_users_phone_verified_requires_phone" CHECK ("identity"."users"."phone_verified_at" is null or "identity"."users"."phone" is not null),
	CONSTRAINT "identity_users_row_version_positive" CHECK ("identity"."users"."row_version" > 0),
	CONSTRAINT "identity_users_timestamps_ordered" CHECK ("identity"."users"."updated_at" >= "identity"."users"."created_at")
);
--> statement-breakpoint
CREATE TABLE "system_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."user_credentials" ADD CONSTRAINT "user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_auth_challenges_user_created_idx" ON "identity"."auth_challenges" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "identity_auth_challenges_expires_idx" ON "identity"."auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_user_credentials_user_version_uq" ON "identity"."user_credentials" USING btree ("user_id","credential_version");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_user_credentials_one_active_per_user_uq" ON "identity"."user_credentials" USING btree ("user_id") WHERE "identity"."user_credentials"."disabled_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_user_sessions_token_hash_uq" ON "identity"."user_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "identity_user_sessions_user_created_idx" ON "identity"."user_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "identity_user_sessions_expires_idx" ON "identity"."user_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_users_email_normalized_uq" ON "identity"."users" USING btree (lower(btrim("email")));--> statement-breakpoint
CREATE UNIQUE INDEX "identity_users_phone_e164_uq" ON "identity"."users" USING btree ("phone");