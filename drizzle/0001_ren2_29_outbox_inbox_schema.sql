CREATE SCHEMA "platform";
--> statement-breakpoint
CREATE TABLE "platform"."dead_letter_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"job_id" uuid,
	"event_id" uuid,
	"reason_code" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"assigned_to_id" uuid,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "platform_dead_letter_cases_target_required" CHECK ("platform"."dead_letter_cases"."job_id" is not null or "platform"."dead_letter_cases"."event_id" is not null),
	CONSTRAINT "platform_dead_letter_cases_reason_code_safe" CHECK ("platform"."dead_letter_cases"."reason_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "platform_dead_letter_cases_state_valid" CHECK ("platform"."dead_letter_cases"."state" in ('open', 'requeued', 'resolved')),
	CONSTRAINT "platform_dead_letter_cases_resolution_consistent" CHECK (("platform"."dead_letter_cases"."state" = 'resolved') = ("platform"."dead_letter_cases"."resolved_at" is not null)),
	CONSTRAINT "platform_dead_letter_cases_row_version_positive" CHECK ("platform"."dead_letter_cases"."row_version" > 0),
	CONSTRAINT "platform_dead_letter_cases_timestamps_ordered" CHECK ("platform"."dead_letter_cases"."updated_at" >= "platform"."dead_letter_cases"."created_at")
);
--> statement-breakpoint
CREATE TABLE "platform"."durable_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"job_kind" text NOT NULL,
	"business_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"lease_owner" text,
	"lease_started_at" timestamp with time zone,
	"last_error_code" text,
	CONSTRAINT "platform_durable_jobs_state_valid" CHECK ("platform"."durable_jobs"."state" in ('pending', 'leased', 'succeeded', 'dead_letter')),
	CONSTRAINT "platform_durable_jobs_attempts_bounded" CHECK ("platform"."durable_jobs"."attempt_count" >= 0 and "platform"."durable_jobs"."max_attempts" between 1 and 5 and "platform"."durable_jobs"."attempt_count" <= "platform"."durable_jobs"."max_attempts"),
	CONSTRAINT "platform_durable_jobs_lease_consistent" CHECK (("platform"."durable_jobs"."state" = 'leased' and "platform"."durable_jobs"."lease_until" is not null and "platform"."durable_jobs"."lease_started_at" is not null and "platform"."durable_jobs"."lease_owner" is not null) or ("platform"."durable_jobs"."state" <> 'leased' and "platform"."durable_jobs"."lease_until" is null and "platform"."durable_jobs"."lease_started_at" is null and "platform"."durable_jobs"."lease_owner" is null)),
	CONSTRAINT "platform_durable_jobs_lease_bounded" CHECK ("platform"."durable_jobs"."lease_until" is null or ("platform"."durable_jobs"."lease_started_at" <= "platform"."durable_jobs"."lease_until" and "platform"."durable_jobs"."lease_until" <= "platform"."durable_jobs"."lease_started_at" + interval '5 minutes')),
	CONSTRAINT "platform_durable_jobs_safe_error_code" CHECK ("platform"."durable_jobs"."last_error_code" is null or "platform"."durable_jobs"."last_error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "platform_durable_jobs_row_version_positive" CHECK ("platform"."durable_jobs"."row_version" > 0),
	CONSTRAINT "platform_durable_jobs_timestamps_ordered" CHECK ("platform"."durable_jobs"."updated_at" >= "platform"."durable_jobs"."created_at")
);
--> statement-breakpoint
CREATE TABLE "platform"."inbox_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumer_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"event_version" integer NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_inbox_receipts_event_version_positive" CHECK ("platform"."inbox_receipts"."event_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer NOT NULL,
	"event_payload" jsonb NOT NULL,
	"event_key" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "platform_outbox_events_version_positive" CHECK ("platform"."outbox_events"."event_version" > 0),
	CONSTRAINT "platform_outbox_events_row_version_positive" CHECK ("platform"."outbox_events"."row_version" > 0),
	CONSTRAINT "platform_outbox_events_timestamps_ordered" CHECK ("platform"."outbox_events"."updated_at" >= "platform"."outbox_events"."created_at")
);
--> statement-breakpoint
CREATE TABLE "platform"."webhook_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"signature_verified" boolean NOT NULL,
	"payload_hash" char(64) NOT NULL,
	"payload_key" text,
	"state" text DEFAULT 'received' NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "platform_webhook_inbox_payload_hash_sha256" CHECK ("platform"."webhook_inbox"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "platform_webhook_inbox_state_valid" CHECK ("platform"."webhook_inbox"."state" in ('received', 'processing', 'processed', 'failed')),
	CONSTRAINT "platform_webhook_inbox_processed_verified" CHECK ("platform"."webhook_inbox"."processed_at" is null or ("platform"."webhook_inbox"."signature_verified" and "platform"."webhook_inbox"."state" = 'processed')),
	CONSTRAINT "platform_webhook_inbox_row_version_positive" CHECK ("platform"."webhook_inbox"."row_version" > 0),
	CONSTRAINT "platform_webhook_inbox_timestamps_ordered" CHECK ("platform"."webhook_inbox"."updated_at" >= "platform"."webhook_inbox"."created_at")
);
--> statement-breakpoint
ALTER TABLE "platform"."dead_letter_cases" ADD CONSTRAINT "dead_letter_cases_job_id_durable_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "platform"."durable_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."dead_letter_cases" ADD CONSTRAINT "dead_letter_cases_event_id_outbox_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "platform"."outbox_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."dead_letter_cases" ADD CONSTRAINT "dead_letter_cases_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."inbox_receipts" ADD CONSTRAINT "inbox_receipts_message_id_outbox_events_id_fk" FOREIGN KEY ("message_id") REFERENCES "platform"."outbox_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_dead_letter_cases_open_idx" ON "platform"."dead_letter_cases" USING btree ("created_at","id") WHERE "platform"."dead_letter_cases"."state" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "platform_durable_jobs_business_key_uq" ON "platform"."durable_jobs" USING btree ("job_kind","business_key");--> statement-breakpoint
CREATE INDEX "platform_durable_jobs_pending_claim_idx" ON "platform"."durable_jobs" USING btree ("scheduled_for","id") WHERE "platform"."durable_jobs"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "platform_durable_jobs_expired_lease_idx" ON "platform"."durable_jobs" USING btree ("lease_until","id") WHERE "platform"."durable_jobs"."state" = 'leased';--> statement-breakpoint
CREATE UNIQUE INDEX "platform_inbox_receipts_consumer_message_uq" ON "platform"."inbox_receipts" USING btree ("consumer_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_outbox_events_scoped_key_uq" ON "platform"."outbox_events" USING btree ("aggregate_type","aggregate_id","event_key");--> statement-breakpoint
CREATE INDEX "platform_outbox_events_pending_idx" ON "platform"."outbox_events" USING btree ("occurred_at","id") WHERE "platform"."outbox_events"."delivered_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_webhook_inbox_provider_event_uq" ON "platform"."webhook_inbox" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "platform_webhook_inbox_state_idx" ON "platform"."webhook_inbox" USING btree ("state","created_at");