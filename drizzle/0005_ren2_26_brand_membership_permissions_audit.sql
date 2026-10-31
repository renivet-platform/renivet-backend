CREATE SCHEMA "access";
--> statement-breakpoint
CREATE SCHEMA "brands";
--> statement-breakpoint
CREATE TABLE "access"."permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"permission_code" text NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"description" text,
	CONSTRAINT "ren2_26_permissions_code_canonical" CHECK ("access"."permissions"."permission_code" ~ '^[a-z][a-z0-9_.]{0,127}$'),
	CONSTRAINT "ren2_26_permissions_resource_canonical" CHECK ("access"."permissions"."resource" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "ren2_26_permissions_action_canonical" CHECK ("access"."permissions"."action" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "ren2_26_permissions_row_version_positive" CHECK ("access"."permissions"."row_version" > 0),
	CONSTRAINT "ren2_26_permissions_timestamps_ordered" CHECK ("access"."permissions"."updated_at" >= "access"."permissions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "access"."role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"brand_id" uuid,
	"scope_type" text NOT NULL,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"active_until" timestamp with time zone,
	"granted_by_id" uuid NOT NULL,
	CONSTRAINT "ren2_26_role_assignments_scope_consistent" CHECK (("access"."role_assignments"."scope_type" = 'global' AND "access"."role_assignments"."brand_id" IS NULL) OR ("access"."role_assignments"."scope_type" = 'brand' AND "access"."role_assignments"."brand_id" IS NOT NULL)),
	CONSTRAINT "ren2_26_role_assignments_scope_valid" CHECK ("access"."role_assignments"."scope_type" IN ('global', 'brand')),
	CONSTRAINT "ren2_26_role_assignments_validity_ordered" CHECK ("access"."role_assignments"."active_until" IS NULL OR "access"."role_assignments"."active_until" > "access"."role_assignments"."active_from"),
	CONSTRAINT "ren2_26_role_assignments_row_version_positive" CHECK ("access"."role_assignments"."row_version" > 0),
	CONSTRAINT "ren2_26_role_assignments_timestamps_ordered" CHECK ("access"."role_assignments"."updated_at" >= "access"."role_assignments"."created_at")
);
--> statement-breakpoint
CREATE TABLE "access"."role_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "ren2_26_role_permissions_row_version_positive" CHECK ("access"."role_permissions"."row_version" > 0),
	CONSTRAINT "ren2_26_role_permissions_timestamps_ordered" CHECK ("access"."role_permissions"."updated_at" >= "access"."role_permissions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "access"."roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"role_code" text NOT NULL,
	"scope_kind" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ren2_26_roles_id_scope_uq" UNIQUE("id","scope_kind"),
	CONSTRAINT "ren2_26_roles_code_canonical" CHECK ("access"."roles"."role_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "ren2_26_roles_scope_valid" CHECK ("access"."roles"."scope_kind" IN ('global', 'brand')),
	CONSTRAINT "ren2_26_roles_row_version_positive" CHECK ("access"."roles"."row_version" > 0),
	CONSTRAINT "ren2_26_roles_timestamps_ordered" CHECK ("access"."roles"."updated_at" >= "access"."roles"."created_at")
);
--> statement-breakpoint
CREATE TABLE "access"."security_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"request_id" text NOT NULL,
	"ip_hash" text,
	"payload_hash" char(64) NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ren2_26_security_audit_action_canonical" CHECK ("access"."security_audit_events"."action" ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
	CONSTRAINT "ren2_26_security_audit_subject_type_canonical" CHECK ("access"."security_audit_events"."subject_type" ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
	CONSTRAINT "ren2_26_security_audit_request_id_safe" CHECK ("access"."security_audit_events"."request_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
	CONSTRAINT "ren2_26_security_audit_ip_hash_sha256" CHECK ("access"."security_audit_events"."ip_hash" IS NULL OR "access"."security_audit_events"."ip_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ren2_26_security_audit_payload_hash_sha256" CHECK ("access"."security_audit_events"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ren2_26_security_audit_row_version_positive" CHECK ("access"."security_audit_events"."row_version" > 0),
	CONSTRAINT "ren2_26_security_audit_timestamps_ordered" CHECK ("access"."security_audit_events"."updated_at" >= "access"."security_audit_events"."created_at")
);
--> statement-breakpoint
CREATE TABLE "brands"."brand_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"brand_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"membership_state" text NOT NULL,
	"invited_by_id" uuid,
	"joined_at" timestamp with time zone,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	CONSTRAINT "ren2_26_brand_memberships_user_brand_uq" UNIQUE("user_id","brand_id"),
	CONSTRAINT "ren2_26_brand_memberships_state_valid" CHECK ("brands"."brand_memberships"."membership_state" IN ('invited', 'pending', 'active', 'suspended', 'revoked')),
	CONSTRAINT "ren2_26_brand_memberships_active_joined" CHECK ("brands"."brand_memberships"."membership_state" <> 'active' OR "brands"."brand_memberships"."joined_at" IS NOT NULL),
	CONSTRAINT "ren2_26_brand_memberships_validity_ordered" CHECK ("brands"."brand_memberships"."valid_until" IS NULL OR "brands"."brand_memberships"."valid_until" > "brands"."brand_memberships"."valid_from"),
	CONSTRAINT "ren2_26_brand_memberships_row_version_positive" CHECK ("brands"."brand_memberships"."row_version" > 0),
	CONSTRAINT "ren2_26_brand_memberships_timestamps_ordered" CHECK ("brands"."brand_memberships"."updated_at" >= "brands"."brand_memberships"."created_at")
);
--> statement-breakpoint
CREATE TABLE "brands"."brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"onboarding_state" text NOT NULL,
	"country_code" char(2),
	"tax_id_ref" text,
	CONSTRAINT "ren2_26_brands_slug_canonical" CHECK ("brands"."brands"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "ren2_26_brands_legal_name_nonblank" CHECK (length(btrim("brands"."brands"."legal_name")) > 0),
	CONSTRAINT "ren2_26_brands_display_name_nonblank" CHECK (length(btrim("brands"."brands"."display_name")) > 0),
	CONSTRAINT "ren2_26_brands_onboarding_state_nonblank" CHECK (length(btrim("brands"."brands"."onboarding_state")) > 0),
	CONSTRAINT "ren2_26_brands_country_code_uppercase" CHECK ("brands"."brands"."country_code" IS NULL OR "brands"."brands"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "ren2_26_brands_row_version_positive" CHECK ("brands"."brands"."row_version" > 0),
	CONSTRAINT "ren2_26_brands_timestamps_ordered" CHECK ("brands"."brands"."updated_at" >= "brands"."brands"."created_at")
);
--> statement-breakpoint
ALTER TABLE "access"."role_assignments" ADD CONSTRAINT "role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."role_assignments" ADD CONSTRAINT "role_assignments_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "brands"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."role_assignments" ADD CONSTRAINT "role_assignments_granted_by_id_users_id_fk" FOREIGN KEY ("granted_by_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."role_assignments" ADD CONSTRAINT "ren2_26_role_assignments_role_scope_fk" FOREIGN KEY ("role_id","scope_type") REFERENCES "access"."roles"("id","scope_kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."role_assignments" ADD CONSTRAINT "ren2_26_role_assignments_membership_fk" FOREIGN KEY ("user_id","brand_id") REFERENCES "brands"."brand_memberships"("user_id","brand_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "access"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "access"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."security_audit_events" ADD CONSTRAINT "security_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands"."brand_memberships" ADD CONSTRAINT "brand_memberships_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "brands"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands"."brand_memberships" ADD CONSTRAINT "brand_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands"."brand_memberships" ADD CONSTRAINT "brand_memberships_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "identity"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ren2_26_permissions_code_uq" ON "access"."permissions" USING btree ("permission_code");--> statement-breakpoint
CREATE UNIQUE INDEX "ren2_26_role_assignments_global_uq" ON "access"."role_assignments" USING btree ("user_id","role_id") WHERE "access"."role_assignments"."brand_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ren2_26_role_assignments_brand_uq" ON "access"."role_assignments" USING btree ("user_id","role_id","brand_id") WHERE "access"."role_assignments"."brand_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ren2_26_role_assignments_global_active_idx" ON "access"."role_assignments" USING btree ("user_id","active_from","active_until") WHERE "access"."role_assignments"."scope_type" = 'global';--> statement-breakpoint
CREATE INDEX "ren2_26_role_assignments_brand_active_idx" ON "access"."role_assignments" USING btree ("brand_id","user_id","active_from","active_until") WHERE "access"."role_assignments"."scope_type" = 'brand';--> statement-breakpoint
CREATE UNIQUE INDEX "ren2_26_role_permissions_role_permission_uq" ON "access"."role_permissions" USING btree ("role_id","permission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ren2_26_roles_code_uq" ON "access"."roles" USING btree ("role_code");--> statement-breakpoint
CREATE INDEX "ren2_26_security_audit_actor_created_idx" ON "access"."security_audit_events" USING btree ("actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ren2_26_security_audit_subject_created_idx" ON "access"."security_audit_events" USING btree ("subject_type","subject_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ren2_26_security_audit_action_created_idx" ON "access"."security_audit_events" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE INDEX "ren2_26_brand_memberships_brand_state_idx" ON "brands"."brand_memberships" USING btree ("brand_id","membership_state","user_id");--> statement-breakpoint
CREATE INDEX "ren2_26_brand_memberships_user_state_idx" ON "brands"."brand_memberships" USING btree ("user_id","membership_state","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ren2_26_brands_slug_uq" ON "brands"."brands" USING btree ("slug");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION access.reject_security_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, access
AS $$
BEGIN
  RAISE EXCEPTION 'access.security_audit_events is append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER access_security_audit_events_immutable
BEFORE UPDATE OR DELETE ON access.security_audit_events
FOR EACH ROW EXECUTE FUNCTION access.reject_security_audit_mutation();
--> statement-breakpoint
INSERT INTO access.roles (role_code, scope_kind, description, is_system)
VALUES
  ('renivet_admin', 'global', 'Manage Renivet staff access, brand membership decisions, and access audit.', true),
  ('renivet_support', 'global', 'Read basic account and brand status for support.', true),
  ('brand_owner', 'brand', 'Manage staff membership for the assigned brand, excluding owner promotion.', true),
  ('brand_staff', 'brand', 'Read the assigned brand membership and role only.', true)
ON CONFLICT (role_code) DO NOTHING;
--> statement-breakpoint
INSERT INTO access.permissions (permission_code, resource, action, description)
VALUES
  ('staff_access.manage', 'staff_access', 'manage', 'Manage global Renivet staff role assignments.'),
  ('brand_membership.review', 'brand_membership', 'review', 'Review and approve or reject brand membership requests.'),
  ('brand_membership.manage', 'brand_membership', 'manage', 'Manage brand membership lifecycle across brands.'),
  ('access_audit.read', 'access_audit', 'read', 'Read Renivet-wide access change audit records.'),
  ('account_status.read', 'account_status', 'read', 'Read basic account status for support.'),
  ('brand_status.read', 'brand_status', 'read', 'Read basic brand onboarding status for support.'),
  ('brand_membership.read', 'brand_membership', 'read', 'Read member list for the assigned brand.'),
  ('brand_membership.invite', 'brand_membership', 'invite', 'Invite staff to the assigned brand.'),
  ('brand_membership.revoke', 'brand_membership', 'revoke', 'Revoke staff access to the assigned brand.'),
  ('brand_role.assign_staff', 'brand_role', 'assign_staff', 'Assign the limited Brand Staff role; cannot grant ownership.'),
  ('brand_access_audit.read', 'brand_access_audit', 'read', 'Read access changes for the assigned brand.'),
  ('brand_membership.read_self', 'brand_membership', 'read_self', 'Read own membership and role for the assigned brand.')
ON CONFLICT (permission_code) DO NOTHING;
--> statement-breakpoint
WITH grants (role_code, permission_code) AS (
  VALUES
    ('renivet_admin', 'staff_access.manage'),
    ('renivet_admin', 'brand_membership.review'),
    ('renivet_admin', 'brand_membership.manage'),
    ('renivet_admin', 'access_audit.read'),
    ('renivet_support', 'account_status.read'),
    ('renivet_support', 'brand_status.read'),
    ('brand_owner', 'brand_membership.read'),
    ('brand_owner', 'brand_membership.invite'),
    ('brand_owner', 'brand_membership.revoke'),
    ('brand_owner', 'brand_role.assign_staff'),
    ('brand_owner', 'brand_access_audit.read'),
    ('brand_staff', 'brand_membership.read_self')
)
INSERT INTO access.role_permissions (role_id, permission_id)
SELECT roles.id, permissions.id
FROM grants
JOIN access.roles AS roles USING (role_code)
JOIN access.permissions AS permissions USING (permission_code)
ON CONFLICT (role_id, permission_id) DO NOTHING;
--> statement-breakpoint
CREATE VIEW access.effective_permissions AS
SELECT
  assignments.user_id,
  assignments.role_id,
  roles.role_code,
  assignments.scope_type,
  assignments.brand_id,
  permissions.permission_code
FROM access.role_assignments AS assignments
JOIN identity.users AS users
  ON users.id = assignments.user_id
 AND users.state = 'active'
JOIN access.roles AS roles
  ON roles.id = assignments.role_id
 AND roles.scope_kind = assignments.scope_type
JOIN access.role_permissions AS role_permissions
  ON role_permissions.role_id = roles.id
JOIN access.permissions AS permissions
  ON permissions.id = role_permissions.permission_id
LEFT JOIN brands.brand_memberships AS memberships
  ON memberships.user_id = assignments.user_id
 AND memberships.brand_id = assignments.brand_id
 AND memberships.membership_state = 'active'
 AND memberships.joined_at IS NOT NULL
 AND memberships.valid_from <= CURRENT_TIMESTAMP
 AND (memberships.valid_until IS NULL OR memberships.valid_until > CURRENT_TIMESTAMP)
LEFT JOIN brands.brands AS brands
  ON brands.id = assignments.brand_id
 AND brands.onboarding_state = 'approved'
WHERE assignments.active_from <= CURRENT_TIMESTAMP
  AND (assignments.active_until IS NULL OR assignments.active_until > CURRENT_TIMESTAMP)
  AND (
    (assignments.scope_type = 'global' AND assignments.brand_id IS NULL)
    OR (
      assignments.scope_type = 'brand'
      AND assignments.brand_id IS NOT NULL
      AND memberships.id IS NOT NULL
      AND brands.id IS NOT NULL
    )
  );
