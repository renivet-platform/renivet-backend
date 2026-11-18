-- REN2-117: brand-scoped, purpose-limited 7-day team invitations.
-- The email invitation does not create a usable role. Only a verified,
-- authenticated recipient explicitly accepting it receives brand access.
CREATE TABLE IF NOT EXISTS brands.team_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 brand_id uuid NOT NULL REFERENCES brands.brands(id),
 email text NOT NULL,
 role_code text NOT NULL,
 token_hash char(64) NOT NULL UNIQUE,
 invited_by_id uuid NOT NULL REFERENCES identity.users(id),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','cancelled','expired')),
 delivery_state text NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending','sent','failed')),
 expires_at timestamptz NOT NULL,
 accepted_by_id uuid REFERENCES identity.users(id),
 accepted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT team_invites_email_canonical CHECK (email=lower(btrim(email)) AND position('@' IN email)>1),
 CONSTRAINT team_invites_role_safe CHECK (role_code IN ('catalogue_editor','stock_manager')),
 CONSTRAINT team_invites_expiry CHECK (expires_at>created_at)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS team_invitations_brand_state_idx ON brands.team_invitations(brand_id,state,created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS team_invitations_email_pending_idx ON brands.team_invitations(email,state,expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS team_invitations_one_pending_idx ON brands.team_invitations(brand_id,email) WHERE state='pending';
--> statement-breakpoint
INSERT INTO access.roles(role_code,scope_kind,description,is_system)
VALUES
 ('catalogue_editor','brand','Edit catalogue drafts, variants, prices and imports. Cannot change stock or manage team.',true),
 ('stock_manager','brand','Record stock receipts and counts. Cannot approve own adjustments or manage team.',true)
ON CONFLICT (role_code) DO NOTHING;
--> statement-breakpoint
-- Map to the canonical existing permission registry; do not invent
-- a permission merely to make a UI control seem functional.
WITH grants(role_code,permission_code) AS (
 VALUES
 ('catalogue_editor','brand_membership.read_self'),
 ('catalogue_editor','catalog.read'),
 ('catalogue_editor','catalog.write'),
 ('catalogue_editor','catalog.submit'),
 ('catalogue_editor','pricing.read'),
 ('catalogue_editor','pricing.write'),
 ('catalogue_editor','imports.write'),
 ('catalogue_editor','imports.confirm'),
 ('stock_manager','brand_membership.read_self'),
 ('stock_manager','inventory.read'),
 ('stock_manager','inventory.submit'),
 ('stock_manager','inventory.count'),
 ('stock_manager','inventory.adjust.propose')
)
INSERT INTO access.role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM grants g
 JOIN access.roles r ON r.role_code=g.role_code AND r.scope_kind='brand'
 JOIN access.permissions p ON p.permission_code=g.permission_code
ON CONFLICT (role_id,permission_id) DO NOTHING;
