-- REN2-50 additive W2 catalogue, media, imports, and inventory schema (PostgreSQL 16).
-- Adapted from Engineering OS W2 v1.5 SQL candidate and reviewed against W1 Drizzle migrations 0000-0005.
-- This migration adds W2 objects only; canonical brands.brands remains the sole brand root.
-- Requires btree_gist extension privileges. Deployment/production migration remains separately owner-controlled.

CREATE SCHEMA IF NOT EXISTS catalogue;
--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS media;
--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS imports;
--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS inventory;
--> statement-breakpoint

-- Requires database administrator approval and extension availability in target deployment.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint


-- Existing W1 brands.brands(id) is assumed; do NOT create another brand table.

CREATE TABLE catalogue.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid NULL REFERENCES catalogue.categories(id),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint


CREATE TABLE catalogue.attributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  value_type text NOT NULL CHECK(value_type IN ('text','integer','decimal','boolean','enum','multi_enum','date','measurement')),
  scope_type text NOT NULL CHECK(scope_type IN ('product','variant')),
  allowed_values jsonb NULL,
  unit_code text NULL,
  searchable boolean NOT NULL DEFAULT false,
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version > 0)
);
--> statement-breakpoint


CREATE TABLE catalogue.category_attributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES catalogue.categories(id),
  attribute_id uuid NOT NULL REFERENCES catalogue.attributes(id),
  schema_version integer NOT NULL CHECK(schema_version > 0),
  required_by_default boolean NOT NULL DEFAULT false,
  conditional_rule jsonb NULL, -- validated schema/rule interpreter, never arbitrary eval
  min_values integer NULL,
  max_values integer NULL,
  UNIQUE(category_id,attribute_id,schema_version)
);
--> statement-breakpoint


-- v1.5 canonical immutable versioned taxonomy. categories.schema_version is the
-- pointer to the current version; historical snapshots live here and are never edited.
CREATE TABLE catalogue.category_schema_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES catalogue.categories(id),
  version integer NOT NULL CHECK(version>0),
  state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN('DRAFT','PUBLISHED')),
  ruleset jsonb NOT NULL DEFAULT '{}'::jsonb,
  ruleset_sha256 char(64) NOT NULL,
  validator_version text NOT NULL,
  approved_by uuid NULL,
  published_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(category_id,version),
  UNIQUE(id,category_id,version),
  CHECK(state <> 'PUBLISHED' OR (published_at IS NOT NULL AND approved_by IS NOT NULL))
);
--> statement-breakpoint

-- A category version is a frozen, versioned collection of typed attribute contracts.
CREATE TABLE catalogue.category_schema_attribute_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version_id uuid NOT NULL REFERENCES catalogue.category_schema_versions(id),
  attribute_id uuid NOT NULL REFERENCES catalogue.attributes(id),
  attribute_code text NOT NULL,
  scope_type text NOT NULL CHECK(scope_type IN ('product','variant')),
  value_type text NOT NULL CHECK(value_type IN ('text','integer','decimal','boolean','enum','multi_enum','date','measurement')),
  allowed_values jsonb NULL,
  unit_code text NULL,
  required_by_default boolean NOT NULL DEFAULT false,
  conditional_ast jsonb NULL,
  min_values integer NULL,
  max_values integer NULL,
  UNIQUE(schema_version_id,attribute_code,scope_type),
  UNIQUE(id,schema_version_id,scope_type,attribute_id),
  CHECK(min_values IS NULL OR min_values>=0),
  CHECK(max_values IS NULL OR max_values>=0),
  CHECK(min_values IS NULL OR max_values IS NULL OR max_values>=min_values)
);
--> statement-breakpoint

-- Conditional AST grammar is specified in the master SRS; only approved schema
-- versions can be used for submission and publish; DRAFT versions may be previewed.

CREATE TABLE catalogue.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  category_id uuid NOT NULL REFERENCES catalogue.categories(id),
  style_code text NOT NULL,
  style_code_norm text GENERATED ALWAYS AS (upper(btrim(style_code))) STORED,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  content_version integer NOT NULL DEFAULT 1 CHECK(content_version > 0),
  category_schema_version integer NOT NULL CHECK(category_schema_version > 0),
  publication_state text NOT NULL DEFAULT 'DRAFT' CHECK(publication_state IN
    ('DRAFT','INCOMPLETE','PENDING_REVIEW','APPROVED','PUBLISHED','RE_REVIEW','REJECTED','RESTRICTED','ARCHIVED')),
  qc_state text NOT NULL DEFAULT 'NOT_SUBMITTED',
  published_revision_id uuid NULL,
  published_approval_id uuid NULL,
  published_approval_decision text NULL CHECK(published_approval_decision IS NULL OR published_approval_decision='APPROVED'),
  row_version bigint NOT NULL DEFAULT 1 CHECK(row_version > 0),
  publication_version bigint NOT NULL DEFAULT 1 CHECK(publication_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,brand_id),
  UNIQUE(id,brand_id,category_id,category_schema_version),
  UNIQUE(brand_id,style_code_norm),
  FOREIGN KEY(category_id,category_schema_version) REFERENCES catalogue.category_schema_versions(category_id,version),
  CHECK((published_revision_id IS NULL AND published_approval_id IS NULL AND published_approval_decision IS NULL) OR
        (published_revision_id IS NOT NULL AND published_approval_id IS NOT NULL AND published_approval_decision='APPROVED')),
  CHECK(publication_state<>'PUBLISHED' OR published_revision_id IS NOT NULL),
  CHECK(length(btrim(style_code))>0),
  CHECK(length(btrim(title))>0)
);
--> statement-breakpoint

CREATE INDEX products_brand_state_idx ON catalogue.products(brand_id,publication_state,id);
--> statement-breakpoint


CREATE TABLE catalogue.product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  product_id uuid NOT NULL,
  sku text NOT NULL,
  sku_norm text GENERATED ALWAYS AS (upper(btrim(sku))) STORED,
  option_signature text NOT NULL,
  options jsonb NOT NULL,
  gtin text NULL,
  weight_g integer NULL CHECK(weight_g IS NULL OR weight_g>=0),
  variant_state text NOT NULL DEFAULT 'DRAFT' CHECK(variant_state IN ('DRAFT','ACTIVE','INACTIVE','ARCHIVED')),
  row_version bigint NOT NULL DEFAULT 1 CHECK(row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product_id,brand_id) REFERENCES catalogue.products(id,brand_id),
  UNIQUE(id,brand_id),
  UNIQUE(id,product_id,brand_id),
  UNIQUE(brand_id,sku_norm),
  UNIQUE(product_id,option_signature),
  CHECK(sku ~ '^[A-Za-z0-9_.-]{1,40}$'),
  CHECK(length(option_signature)>0)
);
--> statement-breakpoint

CREATE INDEX variants_parent_idx ON catalogue.product_variants(brand_id,product_id);
--> statement-breakpoint


-- Price window overlaps for approved records require an exclusion constraint or
-- transactional check + index; decide extension btree_gist availability on DO.
CREATE TABLE catalogue.variant_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  currency text NOT NULL DEFAULT 'INR' CHECK(currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK(amount_minor>=0),
  mrp_minor bigint NOT NULL CHECK(mrp_minor>0),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NULL,
  price_state text NOT NULL CHECK(price_state IN ('DRAFT','PENDING','APPROVED','REJECTED','EXPIRED')),
  rule_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(variant_id,brand_id) REFERENCES catalogue.product_variants(id,brand_id),
  UNIQUE(id,brand_id,variant_id),
  CHECK(amount_minor<=mrp_minor),
  CHECK(valid_to IS NULL OR valid_to>valid_from),
  CONSTRAINT approved_price_no_overlap EXCLUDE USING gist (
     brand_id WITH =, variant_id WITH =, currency WITH =,
     tstzrange(valid_from,COALESCE(valid_to,'infinity'::timestamptz),'[)') WITH &&
  ) WHERE (price_state='APPROVED')
);
--> statement-breakpoint

-- Approved price row changes must go via permission-gated transactional supersession
-- with immutable price_audit_events, never unrestricted UPDATE/DELETE.
CREATE INDEX price_variant_effective_idx ON catalogue.variant_prices(brand_id,variant_id,price_state,valid_from);
--> statement-breakpoint


CREATE TABLE catalogue.product_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  product_id uuid NOT NULL,
  content_version integer NOT NULL,
  content_snapshot jsonb NOT NULL,
  content_sha256 char(64) NOT NULL,
  submitted_by uuid NOT NULL,
  review_state text NOT NULL DEFAULT 'DRAFT' CHECK(review_state IN('DRAFT','SUBMITTED','APPROVED','REJECTED','SUPERSEDED')),
  category_id uuid NOT NULL,
  category_schema_version integer NOT NULL CHECK(category_schema_version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product_id,brand_id) REFERENCES catalogue.products(id,brand_id),
  FOREIGN KEY(category_id,category_schema_version) REFERENCES catalogue.category_schema_versions(category_id,version),
  UNIQUE(product_id,content_version),
  UNIQUE(id,product_id,brand_id)
);
--> statement-breakpoint


CREATE TABLE catalogue.product_qc_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  product_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  reviewer_user_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN('APPROVED','REJECTED','CORRECTION_REQUIRED','RESTRICTED')),
  reason_code text NOT NULL,
  comment text NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product_id,brand_id) REFERENCES catalogue.products(id,brand_id),
  FOREIGN KEY(revision_id,product_id,brand_id) REFERENCES catalogue.product_revisions(id,product_id,brand_id),
  UNIQUE(id,revision_id,product_id,brand_id,decision)
  -- maker != reviewer checked in transaction with revision.submitted_by, plus policy
);
--> statement-breakpoint


-- v1.5: a published product must link to the EXACT reviewed, approved snapshot.
-- Approval rows and revisions are append-only; mutable draft fields do not
-- rewrite an already published revision. Restriction retains the snapshot.
ALTER TABLE catalogue.products ADD CONSTRAINT products_published_review_fk
  FOREIGN KEY(published_approval_id,published_revision_id,id,brand_id,published_approval_decision)
  REFERENCES catalogue.product_qc_reviews(id,revision_id,product_id,brand_id,decision);
--> statement-breakpoint

CREATE UNIQUE INDEX qc_one_approved_decision_per_revision
  ON catalogue.product_qc_reviews(revision_id) WHERE decision='APPROVED';
--> statement-breakpoint


CREATE TABLE media.media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  storage_key text NOT NULL,
  sha256 char(64) NOT NULL,
  mime_type text NOT NULL,
  width integer NULL,
  height integer NULL,
  scan_state text NOT NULL DEFAULT 'PENDING' CHECK(scan_state IN ('PENDING','CLEAN','REJECTED')),
  rights_state text NOT NULL DEFAULT 'UNVERIFIED' CHECK(rights_state IN ('UNVERIFIED','ATTESTED','REVIEWED','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,brand_id),
  UNIQUE(brand_id,storage_key)
  -- hash equality may not imply same rights; dedupe only via business service
);
--> statement-breakpoint


CREATE TABLE media.product_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  product_id uuid NOT NULL,
  variant_id uuid NULL,
  media_asset_id uuid NOT NULL,
  display_role text NOT NULL,
  display_order integer NOT NULL CHECK(display_order>=0),
  alt_text text NOT NULL DEFAULT '',
  FOREIGN KEY(product_id,brand_id) REFERENCES catalogue.products(id,brand_id),
  FOREIGN KEY(variant_id,product_id,brand_id) REFERENCES catalogue.product_variants(id,product_id,brand_id),
  FOREIGN KEY(media_asset_id,brand_id) REFERENCES media.media_assets(id,brand_id),
  UNIQUE(brand_id,product_id,variant_id,display_order)
  -- Variant triple is nullable only for parent-level media; all other columns NOT NULL
);
--> statement-breakpoint


-- Enforce ordering of parent-level images (NULL variant cannot be handled
-- by ordinary composite UNIQUE because NULLs are distinct).
CREATE UNIQUE INDEX product_media_parent_order_uq
  ON media.product_media(brand_id,product_id,display_order) WHERE variant_id IS NULL;
--> statement-breakpoint


CREATE TABLE imports.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  source_kind text NOT NULL,
  source_sha256 char(64) NOT NULL,
  raw_storage_key text NOT NULL,
  schema_version text NOT NULL,
  source_as_of timestamptz NOT NULL,
  preview_revision bigint NOT NULL DEFAULT 0,
  preview_hash char(64) NULL,
  job_state text NOT NULL,
  requested_policy jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,brand_id)
);
--> statement-breakpoint

CREATE INDEX imports_brand_status_idx ON imports.import_batches(brand_id,job_state,created_at,id);
--> statement-breakpoint


CREATE TABLE imports.import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  source_row_number integer NOT NULL CHECK(source_row_number>0),
  raw_record jsonb NOT NULL,
  canonical_record jsonb NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]',
  intended_action text NULL,
  row_state text NOT NULL DEFAULT 'STAGED',
  target_product_id uuid NULL,
  target_variant_id uuid NULL,
  result_receipt jsonb NULL,
  FOREIGN KEY(batch_id,brand_id) REFERENCES imports.import_batches(id,brand_id),
  UNIQUE(batch_id,source_row_number)
);
--> statement-breakpoint


-- Removed untyped polymorphic external ID mapping. See typed maps below.

CREATE TABLE inventory.stock_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands.brands(id),
  location_code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,brand_id),
  UNIQUE(brand_id,location_code)
);
--> statement-breakpoint


CREATE TABLE inventory.stock_balances (
  brand_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  physical_on_hand bigint NOT NULL DEFAULT 0 CHECK(physical_on_hand>=0),
  quarantined bigint NOT NULL DEFAULT 0 CHECK(quarantined>=0),
  other_non_sellable bigint NOT NULL DEFAULT 0 CHECK(other_non_sellable>=0),
  allocated_not_dispatched bigint NOT NULL DEFAULT 0 CHECK(allocated_not_dispatched>=0),
  pre_payment_held bigint NOT NULL DEFAULT 0 CHECK(pre_payment_held=0), -- policy candidate completion-first
  safety_buffer bigint NOT NULL DEFAULT 0 CHECK(safety_buffer>=0),
  row_version bigint NOT NULL DEFAULT 1 CHECK(row_version>0),
  suspended boolean NOT NULL DEFAULT false,
  suspension_reason text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(brand_id,variant_id,location_id),
  FOREIGN KEY(variant_id,brand_id) REFERENCES catalogue.product_variants(id,brand_id),
  FOREIGN KEY(location_id,brand_id) REFERENCES inventory.stock_locations(id,brand_id),
  CHECK(quarantined + other_non_sellable <= physical_on_hand)
  -- IMPORTANT: do not CHECK A<=eligible: verified physical loss may cause shortage.
);
--> statement-breakpoint


-- One canonical, append-only event envelope serializes P/Q/U/A/B on EACH pool.
-- A newly created pool has row_version=1 (empty genesis). First event seq=2.
-- Lock one stock_balances row, assign next version, INSERT stock_events and
-- exactly one matching journal effect in the SAME transaction, then update balance.
CREATE TABLE inventory.stock_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL, variant_id uuid NOT NULL, location_id uuid NOT NULL,
  pool_sequence bigint NOT NULL CHECK(pool_sequence>=2),
  event_kind text NOT NULL CHECK(event_kind IN('PHYSICAL','COMMITMENT','BUFFER')),
  business_effect_key text NOT NULL,
  payload_sha256 char(64) NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
  delta_physical bigint NOT NULL DEFAULT 0,
  delta_quarantined bigint NOT NULL DEFAULT 0,
  delta_other_non_sellable bigint NOT NULL DEFAULT 0,
  delta_allocated bigint NOT NULL DEFAULT 0,
  delta_buffer bigint NOT NULL DEFAULT 0,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(brand_id,variant_id,location_id)
    REFERENCES inventory.stock_balances(brand_id,variant_id,location_id),
  UNIQUE(brand_id,variant_id,location_id,pool_sequence),
  UNIQUE(brand_id,business_effect_key),
  UNIQUE(id,brand_id,variant_id,location_id,event_kind),
  CHECK(delta_physical<>0 OR delta_quarantined<>0 OR delta_other_non_sellable<>0 OR delta_allocated<>0 OR delta_buffer<>0),
  CHECK((event_kind='PHYSICAL' AND delta_allocated=0 AND delta_buffer=0) OR
        (event_kind='COMMITMENT' AND delta_physical=0 AND delta_quarantined=0 AND delta_other_non_sellable=0 AND delta_buffer=0) OR
        (event_kind='BUFFER' AND delta_physical=0 AND delta_quarantined=0 AND delta_other_non_sellable=0 AND delta_allocated=0))
);
--> statement-breakpoint


CREATE TABLE inventory.stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_event_id uuid NOT NULL,
  stock_event_kind text GENERATED ALWAYS AS ('PHYSICAL'::text) STORED,
  brand_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  delta_physical bigint NOT NULL,
  delta_quarantined bigint NOT NULL DEFAULT 0,
  delta_other_non_sellable bigint NOT NULL DEFAULT 0,
  movement_reason text NOT NULL,
  business_effect_key text NOT NULL,
  source_type text NOT NULL,
  source_reference text NOT NULL,
  actor_user_id uuid NULL,
  balance_version_after bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(brand_id,variant_id,location_id)
    REFERENCES inventory.stock_balances(brand_id,variant_id,location_id),
  FOREIGN KEY(stock_event_id,brand_id,variant_id,location_id,stock_event_kind)
    REFERENCES inventory.stock_events(id,brand_id,variant_id,location_id,event_kind),
  UNIQUE(brand_id,business_effect_key),
  CHECK(delta_physical<>0 OR delta_quarantined<>0 OR delta_other_non_sellable<>0)
);
--> statement-breakpoint


CREATE TABLE inventory.stock_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  checkout_id uuid NOT NULL,
  checkout_line_id uuid NOT NULL,
  accepted_sequence bigint NOT NULL CHECK(accepted_sequence>0),
  quantity bigint NOT NULL CHECK(quantity>0),
  dispatched_quantity bigint NOT NULL DEFAULT 0 CHECK(dispatched_quantity>=0),
  allocation_state text NOT NULL CHECK(allocation_state IN
    ('ALLOCATED','PARTIALLY_SHIPPED','DISPATCHED','CANCELLED','RECOVERY')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(brand_id,variant_id,location_id)
    REFERENCES inventory.stock_balances(brand_id,variant_id,location_id),
  UNIQUE(id,brand_id,variant_id,location_id),
  UNIQUE(checkout_id,checkout_line_id,location_id),
  CHECK(dispatched_quantity<=quantity)
);
--> statement-breakpoint

CREATE INDEX allocation_active_pool_idx ON inventory.stock_allocations(brand_id,variant_id,location_id,allocation_state);
--> statement-breakpoint


CREATE TABLE inventory.stock_commitment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_event_id uuid NOT NULL,
  stock_event_kind text GENERATED ALWAYS AS ('COMMITMENT'::text) STORED,
  brand_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  delta_allocated bigint NOT NULL CHECK(delta_allocated<>0),
  business_effect_key text NOT NULL,
  reason text NOT NULL,
  balance_version_after bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(brand_id,variant_id,location_id)
    REFERENCES inventory.stock_balances(brand_id,variant_id,location_id),
  FOREIGN KEY(allocation_id,brand_id,variant_id,location_id)
    REFERENCES inventory.stock_allocations(id,brand_id,variant_id,location_id),
  FOREIGN KEY(stock_event_id,brand_id,variant_id,location_id,stock_event_kind)
    REFERENCES inventory.stock_events(id,brand_id,variant_id,location_id,event_kind),
  UNIQUE(brand_id,business_effect_key)
);
--> statement-breakpoint


CREATE TABLE inventory.stock_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  source_namespace text NOT NULL,
  source_reference text NOT NULL,
  source_version text NULL,
  source_as_of timestamptz NOT NULL,
  reported_meaning text NOT NULL,
  reported_quantity bigint NOT NULL,
  review_state text NOT NULL DEFAULT 'STAGED',
  raw_payload jsonb NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(brand_id,variant_id,location_id)
    REFERENCES inventory.stock_balances(brand_id,variant_id,location_id),
  UNIQUE(brand_id,source_namespace,source_reference)
);
--> statement-breakpoint


-- W3-OWNED future mechanism (not to migrate in W2 without the payment contract).
-- Serialize short admission transactions with a single row lock, then insert
-- completion command + increment counter in ONE transaction. Worker may run
-- commands on disjoint stock pools concurrently but must not overtake an older
-- unresolved overlapping claim; use explicit candidate-pool references.
-- CREATE TABLE commerce.allocation_admission_counter(id smallint PRIMARY KEY CHECK(id=1), last_seq bigint NOT NULL);
-- CREATE TABLE commerce.checkout_completion_inbox(... accepted_sequence bigint UNIQUE, source_receipt_hash text, ...);
-- CREATE TABLE commerce.allocation_command_pools(command_id uuid, brand_id uuid, variant_id uuid, location_id uuid, ...);

-- Balance ATP calculation: GREATEST(0, physical_on_hand-quarantined-
--   other_non_sellable-allocated_not_dispatched-pre_payment_held-safety_buffer).
-- Source 'available' must NEVER be blindly mapped to physical_on_hand.
-- Implement approved SQL through DRIZZLE with tested migrations, scoped queries,
-- row locking, and outbox writes in one transaction; NO DIRECT EXECUTION.


-- ================================================================
-- v1.5 CONSOLIDATED ADDITIONS / CLOSURE CONTRACTS; proposal, NOT DEPLOYED
-- ================================================================

-- Immutable price audit entries; revocation/shortening approved windows
-- is only through restricted service transaction which logs before/after.
CREATE TABLE catalogue.price_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  variant_id uuid NOT NULL, price_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('PROPOSED','APPROVED','REJECTED','SUPERSEDED','CORRECTED')),
  prior_snapshot jsonb, next_snapshot jsonb NOT NULL,
  actor_user_id uuid NOT NULL, business_effect_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(price_id,brand_id,variant_id) REFERENCES catalogue.variant_prices(id,brand_id,variant_id),
  UNIQUE(brand_id,business_effect_key)
);
--> statement-breakpoint


-- Categories are versioned; values are typed. Attribute values now reference
-- frozen schema-version rule IDs, NOT legacy mutable category_attributes.
-- DB enforces one-and-only-one typed value; application enforces declared
-- attribute type and category-specific conditional dependency.
CREATE TABLE catalogue.product_attribute_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  product_id uuid NOT NULL, category_id uuid NOT NULL,
  category_schema_version integer NOT NULL CHECK(category_schema_version>0),
  attribute_id uuid NOT NULL,
  schema_version_id uuid NOT NULL,
  frozen_rule_id uuid NOT NULL,
  frozen_scope text GENERATED ALWAYS AS ('product'::text) STORED,
  val_text text, val_integer bigint, val_decimal numeric(20,6),
  val_bool boolean, val_date date, val_enum text, val_json jsonb,
  unit_code text, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product_id,brand_id,category_id,category_schema_version)
    REFERENCES catalogue.products(id,brand_id,category_id,category_schema_version),
  FOREIGN KEY(schema_version_id,category_id,category_schema_version)
    REFERENCES catalogue.category_schema_versions(id,category_id,version),
  FOREIGN KEY(frozen_rule_id,schema_version_id,frozen_scope,attribute_id)
    REFERENCES catalogue.category_schema_attribute_rules(id,schema_version_id,scope_type,attribute_id),
  UNIQUE(brand_id,product_id,attribute_id,category_schema_version),
  CHECK (num_nonnulls(val_text,val_integer,val_decimal,val_bool,val_date,val_enum,val_json)=1)
);
--> statement-breakpoint

CREATE TABLE catalogue.variant_attribute_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  product_id uuid NOT NULL, variant_id uuid NOT NULL,
  category_id uuid NOT NULL, category_schema_version integer NOT NULL CHECK(category_schema_version>0),
  attribute_id uuid NOT NULL,
  schema_version_id uuid NOT NULL,
  frozen_rule_id uuid NOT NULL,
  frozen_scope text GENERATED ALWAYS AS ('variant'::text) STORED,
  val_text text, val_integer bigint, val_decimal numeric(20,6),
  val_bool boolean, val_date date, val_enum text, val_json jsonb,
  unit_code text, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(variant_id,product_id,brand_id)
    REFERENCES catalogue.product_variants(id,product_id,brand_id),
  FOREIGN KEY(product_id,brand_id,category_id,category_schema_version)
    REFERENCES catalogue.products(id,brand_id,category_id,category_schema_version),
  FOREIGN KEY(schema_version_id,category_id,category_schema_version)
    REFERENCES catalogue.category_schema_versions(id,category_id,version),
  FOREIGN KEY(frozen_rule_id,schema_version_id,frozen_scope,attribute_id)
    REFERENCES catalogue.category_schema_attribute_rules(id,schema_version_id,scope_type,attribute_id),
  UNIQUE(brand_id,variant_id,attribute_id,category_schema_version),
  CHECK (num_nonnulls(val_text,val_integer,val_decimal,val_bool,val_date,val_enum,val_json)=1)
);
--> statement-breakpoint


-- A verified claim is valid only when approval and non-expired proof
-- BOTH hold at read/publish time. Never trust a persisted VERIFIED flag
-- alone across time; scheduled expiration triggers restriction/re-review.
CREATE TABLE catalogue.sustainability_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  product_id uuid NOT NULL, revision_id uuid NOT NULL,
  claim_code text NOT NULL, claim_text text NOT NULL,
  claim_state text NOT NULL DEFAULT 'PENDING'
    CHECK(claim_state IN('PENDING','VERIFIED','REJECTED','EXPIRED','REVOKED')),
  approved_at timestamptz, expires_at timestamptz,
  reviewed_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,brand_id,product_id),
  FOREIGN KEY(revision_id,product_id,brand_id)
    REFERENCES catalogue.product_revisions(id,product_id,brand_id),
  CHECK(claim_state <> 'VERIFIED' OR (approved_at IS NOT NULL AND reviewed_by IS NOT NULL))
);
--> statement-breakpoint

CREATE TABLE catalogue.claim_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  product_id uuid NOT NULL, claim_id uuid NOT NULL,
  media_asset_id uuid NOT NULL,
  evidence_state text NOT NULL DEFAULT 'PENDING'
    CHECK(evidence_state IN('PENDING','ACCEPTED','REJECTED','REVOKED')),
  issuer text, document_reference text, document_expires_at timestamptz,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(claim_id,brand_id,product_id)
    REFERENCES catalogue.sustainability_claims(id,brand_id,product_id),
  FOREIGN KEY(media_asset_id,brand_id) REFERENCES media.media_assets(id,brand_id),
  UNIQUE(claim_id,media_asset_id)
);
--> statement-breakpoint

CREATE TABLE catalogue.claim_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  product_id uuid NOT NULL, claim_id uuid NOT NULL,
  review_action text NOT NULL CHECK(review_action IN('VERIFY','REJECT','REVOKE','EXPIRE','REOPEN')),
  reviewer_user_id uuid NOT NULL, reason_code text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(claim_id,brand_id,product_id)
    REFERENCES catalogue.sustainability_claims(id,brand_id,product_id)
);
--> statement-breakpoint


-- Typed source identity mapping; eliminates legacy polymorphic UUID which
-- could point to a resource of the wrong kind or from another brand.
CREATE TABLE imports.external_product_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  source_namespace text NOT NULL, source_account_id text NOT NULL,
  external_product_id text NOT NULL, product_id uuid NOT NULL,
  source_version text, last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product_id,brand_id) REFERENCES catalogue.products(id,brand_id),
  UNIQUE(brand_id,source_namespace,source_account_id,external_product_id)
);
--> statement-breakpoint

CREATE TABLE imports.external_variant_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  source_namespace text NOT NULL, source_account_id text NOT NULL,
  external_variant_id text NOT NULL, variant_id uuid NOT NULL,
  source_version text, last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(variant_id,brand_id) REFERENCES catalogue.product_variants(id,brand_id),
  UNIQUE(brand_id,source_namespace,source_account_id,external_variant_id)
);
--> statement-breakpoint


-- Brand-scoped import command receipts; same idempotency key with changed
-- payload hash MUST return conflict. Row effects and catalog writes happen
-- in ONE transaction with W1 outbox publication events.
CREATE TABLE imports.import_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  preview_revision bigint NOT NULL CHECK(preview_revision>0),
  preview_hash char(64) NOT NULL,
  source_sha256 char(64) NOT NULL,
  mapping_version bigint NOT NULL CHECK(mapping_version>0),
  taxonomy_snapshot_sha256 char(64) NOT NULL,
  target_versions jsonb NOT NULL, -- targetId -> rowVersion captured at preview
  conflict_report jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(batch_id,brand_id) REFERENCES imports.import_batches(id,brand_id),
  UNIQUE(batch_id,preview_revision,preview_hash)
);
--> statement-breakpoint


CREATE TABLE imports.import_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  batch_id uuid NOT NULL, preview_revision bigint NOT NULL,
  preview_hash char(64) NOT NULL, idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  confirmation_state text NOT NULL DEFAULT 'ACCEPTED'
    CHECK(confirmation_state IN('ACCEPTED','RUNNING','PARTIAL','COMPLETED','FAILED')),
  confirmed_by uuid NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(batch_id,brand_id) REFERENCES imports.import_batches(id,brand_id),
  UNIQUE(brand_id,idempotency_key),
  FOREIGN KEY(batch_id,preview_revision,preview_hash) REFERENCES imports.import_previews(batch_id,preview_revision,preview_hash),
  UNIQUE(batch_id,preview_revision,preview_hash)
);
--> statement-breakpoint

CREATE TABLE imports.import_effect_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  batch_id uuid NOT NULL, row_id uuid NOT NULL,
  effect_kind text NOT NULL CHECK(effect_kind IN('PRODUCT_CREATE','PRODUCT_UPDATE','VARIANT_UPSERT','MEDIA_LINK','STOCK_OBSERVATION')),
  effect_key text NOT NULL, logical_target_key text NOT NULL, payload_hash char(64) NOT NULL,
  target_media_asset_id uuid NULL,
  target_product_id uuid, target_variant_id uuid, outcome text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(batch_id,brand_id) REFERENCES imports.import_batches(id,brand_id),
  FOREIGN KEY(target_product_id,brand_id) REFERENCES catalogue.products(id,brand_id),
  FOREIGN KEY(target_variant_id,target_product_id,brand_id) REFERENCES catalogue.product_variants(id,product_id,brand_id),
  FOREIGN KEY(target_media_asset_id,brand_id) REFERENCES media.media_assets(id,brand_id),
  CHECK(length(btrim(logical_target_key))>0),
  CHECK(target_variant_id IS NULL OR target_product_id IS NOT NULL),
  UNIQUE(brand_id,effect_key),
  UNIQUE(batch_id,row_id,effect_kind,logical_target_key)
);
--> statement-breakpoint

-- import_rows already references parent via `(batch_id,brand_id)`; ensure
-- UUID row_id is in the same batch via an added alternate unique key.
ALTER TABLE imports.import_rows
  ADD CONSTRAINT import_rows_identity_scope UNIQUE(id,batch_id,brand_id);
--> statement-breakpoint

ALTER TABLE imports.import_effect_receipts
  ADD CONSTRAINT import_effect_row_scope
  FOREIGN KEY(row_id,batch_id,brand_id)
  REFERENCES imports.import_rows(id,batch_id,brand_id);
--> statement-breakpoint


-- Append-only inventory adjustments and operational reconciliation evidence.
CREATE TABLE inventory.stock_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  variant_id uuid NOT NULL, location_id uuid NOT NULL,
  expected_balance_version bigint NOT NULL CHECK(expected_balance_version>0),
  requested_physical_delta bigint NOT NULL,
  reason_code text NOT NULL, evidence_ref text,
  proposed_by uuid NOT NULL, reviewed_by uuid,
  approval_state text NOT NULL DEFAULT 'PROPOSED'
    CHECK(approval_state IN('PROPOSED','APPROVED','REJECTED','APPLIED')),
  business_effect_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(brand_id,variant_id,location_id)
    REFERENCES inventory.stock_balances(brand_id,variant_id,location_id),
  UNIQUE(brand_id,business_effect_key),
  CHECK(reviewed_by IS NULL OR reviewed_by <> proposed_by)
);
--> statement-breakpoint

-- For applied adjustment, exactly one linked physical movement receipt is required.
ALTER TABLE inventory.stock_adjustments ADD COLUMN applied_movement_id uuid NULL;
--> statement-breakpoint

ALTER TABLE inventory.stock_movements ADD CONSTRAINT stock_movements_brand_pool_id_uq
  UNIQUE(id,brand_id,variant_id,location_id);
--> statement-breakpoint

ALTER TABLE inventory.stock_adjustments ADD CONSTRAINT adjustment_applied_movement_fk
  FOREIGN KEY(applied_movement_id,brand_id,variant_id,location_id)
  REFERENCES inventory.stock_movements(id,brand_id,variant_id,location_id);
--> statement-breakpoint

ALTER TABLE inventory.stock_adjustments ADD CONSTRAINT adjustment_state_receipt_check
  CHECK((approval_state='APPLIED') = (applied_movement_id IS NOT NULL));
--> statement-breakpoint


CREATE TABLE inventory.reconciliation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  variant_id uuid NOT NULL, location_id uuid NOT NULL,
  variance_physical bigint, variance_committed bigint,
  case_state text NOT NULL DEFAULT 'OPEN'
    CHECK(case_state IN('OPEN','UNDER_REVIEW','RESOLVED','DISMISSED')),
  reason_code text NOT NULL, detection_source text NOT NULL,
  resolution_effect_key text, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(brand_id,variant_id,location_id)
    REFERENCES inventory.stock_balances(brand_id,variant_id,location_id)
);
--> statement-breakpoint

CREATE TABLE inventory.cycle_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  variant_id uuid NOT NULL, location_id uuid NOT NULL,
  reported_physical bigint NOT NULL CHECK(reported_physical>=0),
  observed_balance_version bigint NOT NULL,
  count_state text NOT NULL DEFAULT 'SUBMITTED'
    CHECK(count_state IN('SUBMITTED','REVIEWED','RECONCILED','REJECTED')),
  requested_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(brand_id,variant_id,location_id)
    REFERENCES inventory.stock_balances(brand_id,variant_id,location_id)
);
--> statement-breakpoint


-- Buffer changes are auditable and rebuilt alongside physical/commitment ledgers.
CREATE TABLE inventory.stock_buffer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_event_id uuid NOT NULL,
  stock_event_kind text GENERATED ALWAYS AS ('BUFFER'::text) STORED, brand_id uuid NOT NULL,
  variant_id uuid NOT NULL, location_id uuid NOT NULL,
  delta_buffer bigint NOT NULL CHECK(delta_buffer<>0),
  business_effect_key text NOT NULL,
  balance_version_after bigint NOT NULL CHECK(balance_version_after>0),
  approved_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(brand_id,variant_id,location_id)
    REFERENCES inventory.stock_balances(brand_id,variant_id,location_id),
  FOREIGN KEY(stock_event_id,brand_id,variant_id,location_id,stock_event_kind)
    REFERENCES inventory.stock_events(id,brand_id,variant_id,location_id,event_kind),
  UNIQUE(brand_id,business_effect_key)
);
--> statement-breakpoint


-- Inventory transfer is never instantly credited at destination on dispatch.
CREATE TABLE inventory.stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  variant_id uuid NOT NULL, from_location_id uuid NOT NULL,
  to_location_id uuid NOT NULL, quantity bigint NOT NULL CHECK(quantity>0),
  state text NOT NULL CHECK(state IN('CREATED','IN_TRANSIT','RECEIVED','CANCELLED','LOST')),
  dispatch_effect_key text, receipt_effect_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(brand_id,variant_id,from_location_id)
    REFERENCES inventory.stock_balances(brand_id,variant_id,location_id),
  FOREIGN KEY(brand_id,variant_id,to_location_id)
    REFERENCES inventory.stock_balances(brand_id,variant_id,location_id),
  CHECK(from_location_id<>to_location_id),
  UNIQUE(brand_id,dispatch_effect_key),
  UNIQUE(brand_id,receipt_effect_key)
);
--> statement-breakpoint


-- Versioned catalog projection intent; emission to W1 transactional outbox
-- must be atomic with publication_state change and this event record.
CREATE TABLE catalogue.publication_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_id uuid NOT NULL,
  product_id uuid NOT NULL, content_version integer NOT NULL CHECK(content_version>0),
  revision_id uuid NULL, approved_review_id uuid NULL,
  approved_decision text NULL CHECK(approved_decision IS NULL OR approved_decision='APPROVED'),
  payload_sha256 char(64) NOT NULL,
  publication_version bigint NOT NULL CHECK(publication_version>0),
  lifecycle_event text NOT NULL
    CHECK(lifecycle_event IN('PUBLISH','RESTRICT','ARCHIVE','UNPUBLISH')),
  event_id uuid NOT NULL UNIQUE, recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product_id,brand_id) REFERENCES catalogue.products(id,brand_id),
  FOREIGN KEY(approved_review_id,revision_id,product_id,brand_id,approved_decision)
    REFERENCES catalogue.product_qc_reviews(id,revision_id,product_id,brand_id,decision),
  CHECK(lifecycle_event <> 'PUBLISH' OR (approved_review_id IS NOT NULL AND revision_id IS NOT NULL AND approved_decision='APPROVED')),
  UNIQUE(brand_id,product_id,publication_version)
);
--> statement-breakpoint


-- ===== INVARIANTS IMPLEMENTED BY TRANSACTIONAL APPLICATION SERVICE =====
-- I-01: On FIRST stock observation, begin transaction; verify brand membership
-- and FK to variant and location; INSERT stock_balances(pool, all counters=0,
-- row_version=1) ON CONFLICT DO NOTHING; acquire SELECT FOR UPDATE; compare
-- observation's expected_balance_version with current row_version, then stage
-- observation. No stock write from import/parser/connector directly.
-- I-02: For opening stock, approved stock_adjustment / receipt drives a
-- signed physical stock_movement, updates balance and writes W1 outbox in
-- ONE transaction; its business_effect_key is UNIQUE; never apply same count
-- twice. CHECK Q+U<=P and nonnegative P; shortage hold if A > P-Q-U.
-- I-03: Allocation changes A only by a W3 TRUSTED COMMAND; physical dispatch
-- subtracts P and A atomically. Every alloc/release/dispatch and outbox write
-- has unique business_effect_key & request hash; retries return prior receipt.
-- I-04: Reconciliation: P,Q,U derive from genesis + physical movements;
-- A derives from genesis + commitment events; B from stock_buffer_events. Compare with balance and allocation state under snapshot isolation;
-- produce case, never blindly edit a balance. Corrections append new events.
-- I-05: Positive price windows with price_state=APPROVED must not overlap.
-- PostgreSQL exclusion constraint above enforces this; price history preserved
-- via immutable audit journal and restricted versioned supersession procedure.
-- I-06: Full product category mandatory/conditional attribute validation and
-- claim evidence eligibility are application rules using frozen schema_version;
-- database FKs/type column CHECK provide structural safety but do not alone
-- guarantee semantic approval or expiry. Consumer and checkout enforce latest
-- authoritative product publish/restriction, even with stale search projection.
-- I-07: W1 brand-scoped SQL predicates are REQUIRED on every read/list/modify/
-- export/job. Composite FK integrity is NOT a substitute for authorization.


-- ===================== v1.5 APPEND-ONLY & TRANSITION GUARDS =======================
-- These are design-candidate PostgreSQL 16 statements. Reconcile owner grants and
-- Drizzle generation with W1 before running; do not run this as an unreviewed migration.
CREATE OR REPLACE FUNCTION catalogue.reject_mutation_of_immutable_row()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD: % is append-only', TG_TABLE_NAME USING ERRCODE='23514';
END; $$;
--> statement-breakpoint

CREATE TRIGGER product_qc_reviews_immutable BEFORE UPDATE OR DELETE
ON catalogue.product_qc_reviews FOR EACH ROW
EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE TRIGGER stock_events_immutable BEFORE UPDATE OR DELETE
ON inventory.stock_events FOR EACH ROW
EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE
ON inventory.stock_movements FOR EACH ROW
EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE TRIGGER stock_commitment_events_immutable BEFORE UPDATE OR DELETE
ON inventory.stock_commitment_events FOR EACH ROW
EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE TRIGGER stock_buffer_events_immutable BEFORE UPDATE OR DELETE
ON inventory.stock_buffer_events FOR EACH ROW
EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE TRIGGER import_effect_receipts_immutable BEFORE UPDATE OR DELETE
ON imports.import_effect_receipts FOR EACH ROW
EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE TRIGGER import_previews_immutable BEFORE UPDATE OR DELETE
ON imports.import_previews FOR EACH ROW
EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE TRIGGER publication_events_immutable BEFORE UPDATE OR DELETE
ON catalogue.publication_events FOR EACH ROW
EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

-- A published category-schema snapshot is immutable, including its attribute rows.
CREATE OR REPLACE FUNCTION catalogue.guard_category_schema_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.state <> 'DRAFT' THEN RAISE EXCEPTION 'PUBLISHED_SCHEMA_IMMUTABLE'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.state <> 'DRAFT' THEN
    RAISE EXCEPTION 'PUBLISHED_SCHEMA_IMMUTABLE';
  END IF;
  -- DRAFT version may evolve, but category/version identity is immutable.
  -- Once published, *all* its schema content and rules remain frozen.
  IF NEW.category_id<>OLD.category_id OR NEW.version<>OLD.version THEN
    RAISE EXCEPTION 'SCHEMA_IDENTITY_CHANGE_FORBIDDEN';
  END IF;
  IF NEW.state NOT IN ('DRAFT','PUBLISHED') THEN
    RAISE EXCEPTION 'INVALID_SCHEMA_TRANSITION';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint

CREATE TRIGGER category_schema_lifecycle_guard BEFORE UPDATE OR DELETE
ON catalogue.category_schema_versions FOR EACH ROW
EXECUTE FUNCTION catalogue.guard_category_schema_version();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION catalogue.guard_schema_rule_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  v:= CASE WHEN TG_OP='DELETE' THEN OLD.schema_version_id ELSE NEW.schema_version_id END;
  -- Lock parent to serialize a schema publish against concurrent rule edits.
  PERFORM 1 FROM catalogue.category_schema_versions WHERE id=v AND state='DRAFT' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISHED_SCHEMA_RULE_IMMUTABLE'; END IF;
  IF TG_OP='UPDATE' AND NEW.schema_version_id<>OLD.schema_version_id THEN
    RAISE EXCEPTION 'CATEGORY_SCHEMA_RULE_REPARENT_FORBIDDEN';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint

CREATE TRIGGER category_schema_rule_guard BEFORE INSERT OR UPDATE OR DELETE
ON catalogue.category_schema_attribute_rules FOR EACH ROW
EXECUTE FUNCTION catalogue.guard_schema_rule_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION catalogue.guard_product_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_PRODUCT_REVISION'; END IF;
  IF OLD.review_state<>'DRAFT' THEN RAISE EXCEPTION 'IMMUTABLE_PRODUCT_REVISION'; END IF;
  IF NEW.product_id<>OLD.product_id OR NEW.brand_id<>OLD.brand_id
     OR NEW.content_snapshot<>OLD.content_snapshot OR NEW.content_sha256<>OLD.content_sha256
     OR NEW.category_id<>OLD.category_id OR NEW.category_schema_version<>OLD.category_schema_version THEN
    RAISE EXCEPTION 'PRODUCT_REVISION_CONTENT_IMMUTABLE';
  END IF;
  IF NEW.review_state NOT IN('DRAFT','SUBMITTED') THEN RAISE EXCEPTION 'INVALID_REVISION_TRANSITION'; END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint

CREATE TRIGGER product_revision_guard BEFORE UPDATE OR DELETE
ON catalogue.product_revisions FOR EACH ROW
EXECUTE FUNCTION catalogue.guard_product_revision();
--> statement-breakpoint

-- IMPORTANT: role privileges and transport authorization remain mandatory.
-- The composite review FK proves that an approval was recorded; it does not
-- alone prove complete content validation, role entitlement or freshness.
-- Publish-service transaction MUST: validate revision schema / evidence / media /
-- approved prices; authorization; set published_* on products; insert publication
-- event and W1 outbox; commit atomically. Re-submit uses a NEW revision.
-- Stock mutation transaction MUST lock stock_balances FOR UPDATE, read old
-- row_version, hash canonical effect payload, check UNIQUE business_effect_key,
-- append exactly one stock_events envelope and one typed journal record, apply
-- state delta, increment row_version ONCE and insert W1 outbox atomically.
-- Older event enqueued before a newer one must not be interpreted as a later
-- physical or commitment effect. Do not rely solely on SKIP LOCKED for FIFO.
-- Anomaly: unique keys and triggers do not prove 1:1 journal coverage; the
-- transaction service and reconciliation check must assert exactly one detail
-- row per stock_events envelope. PostgreSQL tests are still mandatory.
