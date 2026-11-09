'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const W2_TABLES = [
  'catalogue.categories', 'catalogue.attributes', 'catalogue.category_attributes',
  'catalogue.category_availability_events',
  'catalogue.category_schema_versions', 'catalogue.category_schema_attribute_rules',
  'catalogue.products', 'catalogue.product_variants', 'catalogue.variant_prices',
  'catalogue.product_field_lineage', 'catalogue.product_mutation_receipts',
  'catalogue.product_revisions', 'catalogue.product_qc_reviews',
  'catalogue.product_submission_receipts', 'catalogue.product_qc_review_events',
  'catalogue.product_review_decision_receipts', 'catalogue.publication_command_receipts',
  'catalogue.search_projection_state',
  'catalogue.price_audit_events', 'catalogue.price_mutation_receipts', 'catalogue.product_attribute_values',
  'catalogue.taxonomy_admin_events',
  'catalogue.variant_attribute_values', 'catalogue.sustainability_claims',
  'catalogue.claim_evidence', 'catalogue.claim_review_events', 'catalogue.claim_mutation_receipts', 'catalogue.publication_events',
  'media.media_assets', 'media.media_derivatives', 'media.upload_audit_events', 'media.product_media', 'media.product_media_audit_events',
  'media.zip_import_audit_events', 'media.zip_import_batches', 'media.zip_import_effects',
  'media.zip_import_remote_items', 'media.zip_mapping_manifest_items', 'media.zip_mapping_manifests',
  'imports.import_batches', 'imports.import_rows', 'imports.import_uploads',
  'imports.import_mapping_profiles',
  'imports.external_product_maps', 'imports.external_variant_maps', 'imports.import_previews',
  'imports.import_confirmations', 'imports.import_effect_receipts', 'imports.import_retry_requests',
  'inventory.stock_locations',
  'inventory.stock_balances', 'inventory.stock_events', 'inventory.stock_movements',
  'inventory.stock_allocations', 'inventory.stock_commitment_events', 'inventory.stock_observations',
  'inventory.stock_adjustments', 'inventory.reconciliation_cases', 'inventory.cycle_counts',
  'inventory.stock_buffer_events', 'inventory.stock_transfers',
  'inventory.stock_command_receipts', 'inventory.stock_adjustment_policy', 'inventory.stock_adjustment_policy_history',
  'inventory.stock_adjustment_events', 'inventory.stock_returns', 'inventory.stock_return_events',
  'inventory.reconciliation_case_events',
];

function disposableDatabaseUrl() {
  const value = process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required for PostgreSQL 16 integration tests');
  const url = new URL(value);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1', 'W2 migration integration database must be loopback only');
  assert.equal(url.pathname, '/renivet_ci');
  assert.equal(url.username, 'renivet_ci');
  return value;
}

async function w1SchemaSignature(client) {
  const result = await client.query(
    `SELECT table_schema, table_name, ordinal_position, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema IN ('identity', 'platform', 'brands', 'access')
      ORDER BY table_schema, table_name, ordinal_position`,
  );
  return result.rows;
}

test('W2 brand-owned catalogue schemas enforce reviewed tables, tenant, uniqueness, price exclusion, and rollback invariants', {
  timeout: 30_000,
  skip: !process.env.RENIVET_TEST_DATABASE_URL,
}, async () => {
  const pool = new Pool({ connectionString: disposableDatabaseUrl(), max: 2, connectionTimeoutMillis: 5_000 });
  const client = await pool.connect();
  try {
    const version = await client.query('SHOW server_version_num');
    const versionNumber = Number(version.rows[0].server_version_num);
    assert.ok(versionNumber >= 160000 && versionNumber < 170000, 'REN2-50 requires disposable PostgreSQL 16');

    const w1Brand = await client.query(
      `SELECT count(*)::integer AS count FROM information_schema.tables
        WHERE table_schema='brands' AND table_name='brands' AND table_type='BASE TABLE'`,
    );
    assert.equal(w1Brand.rows[0].count, 1, 'canonical W1 brands.brands root must remain present');

    const present = await client.query(
      `SELECT table_schema || '.' || table_name AS qualified_name
         FROM information_schema.tables
        WHERE table_type='BASE TABLE' AND table_schema IN ('catalogue','media','imports','inventory')`,
    );
    const actual = new Set(present.rows.map((row) => row.qualified_name));
    const missing = W2_TABLES.filter((name) => !actual.has(name));
    assert.deepEqual(missing, [], `W2 tables missing after migration: ${missing.join(', ')}`);
    assert.deepEqual([...actual].sort(), [...W2_TABLES].sort(), 'migration may add only the reviewed W2 tables');

    const mappingColumns = await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='imports' AND table_name='import_previews' AND column_name='preview_snapshot'`);
    assert.equal(mappingColumns.rowCount, 1, 'preview snapshot must be persisted as an immutable payload');
    const immutableMapping = await client.query(`SELECT tgname FROM pg_trigger
      WHERE tgrelid='imports.import_mapping_profiles'::regclass AND NOT tgisinternal AND tgname='import_mapping_profiles_immutable'`);
    assert.equal(immutableMapping.rowCount, 1, 'mapping revisions must be immutable');

    const duplicateBrandRoots = await client.query(
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_type='BASE TABLE' AND table_schema IN ('catalogue','media','imports','inventory')
          AND table_name IN ('brand','brands')`,
    );
    assert.deepEqual(duplicateBrandRoots.rows, [], 'W2 must not add a duplicate brand root');

    const exclusion = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid='catalogue.variant_prices'::regclass AND contype='x' AND conname='approved_price_no_overlap'`,
    );
    assert.equal(exclusion.rowCount, 1, 'approved price windows must have an exclusion constraint');
    const extension = await client.query(`SELECT 1 FROM pg_extension WHERE extname='btree_gist'`);
    assert.equal(extension.rowCount, 1, 'approved price exclusion dependency btree_gist must be installed');
    const partialIndexes = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname='catalogue'
          AND indexname IN ('approved_price_no_overlap', 'qc_one_approved_decision_per_revision')`,
    );
    const partialIndexDefinitions = new Map(partialIndexes.rows.map((row) => [row.indexname, row.indexdef]));
    assert.match(
      partialIndexDefinitions.get('approved_price_no_overlap') ?? '',
      /WHERE \(price_state = 'APPROVED'::text\)/,
      'approved price exclusion must be partial to approved price rows',
    );
    assert.match(
      partialIndexDefinitions.get('qc_one_approved_decision_per_revision') ?? '',
      /^CREATE UNIQUE INDEX[\s\S]*WHERE \(decision = 'APPROVED'::text\)$/,
      'only one approved QC decision may exist per revision',
    );

    const migration = readFileSync(path.join(__dirname, '..', 'drizzle', '0006_ren2_50_w2_catalog_inventory.sql'), 'utf8');
    const productVariantMigration = readFileSync(path.join(__dirname, '..', 'drizzle', '0010_ren2_60_variant_sku_order_lock.sql'), 'utf8');
    assert.doesNotMatch(migration, /^\s*DROP\s+(?:TABLE|SCHEMA|TYPE)\b/im, 'W2 migration must not drop schemas or tables');
    assert.doesNotMatch(migration, /^\s*ALTER\s+TABLE\s+(?:identity|platform|brands|access)\./im,
      'W2 migration must not alter W1 tables');
    assert.doesNotMatch(migration, /^\s*CREATE\s+TABLE\s+(?:brands\.brands|identity\.users)\b/im,
      'W2 migration must not create duplicate W1 roots');
    assert.doesNotMatch(migration, /ON\s+DELETE\s+CASCADE/i, 'candidate migration must not add unreviewed cascading deletes');
    assert.doesNotMatch(productVariantMigration, /^\s*DROP\s+(?:TABLE|SCHEMA|TYPE)\b/im,
      'REN2-60 must not drop schemas or tables');
    assert.doesNotMatch(productVariantMigration, /^\s*ALTER\s+TABLE\s+(?:identity|platform|brands|access)\./im,
      'REN2-60 must not alter W1 tables');

    const w1Before = await w1SchemaSignature(client);
    await client.query('BEGIN');
    try {
      const brand = await client.query(
        `INSERT INTO brands.brands (slug, legal_name, display_name, onboarding_state)
         VALUES ($1, 'REN2-50 Synthetic Ltd', 'REN2-50 Synthetic', 'approved') RETURNING id`,
        [`ren2-50-${randomUUID()}`],
      );
      const otherBrand = await client.query(
        `INSERT INTO brands.brands (slug, legal_name, display_name, onboarding_state)
         VALUES ($1, 'REN2-60 Synthetic Ltd', 'REN2-60 Synthetic', 'approved') RETURNING id`,
        [`ren2-60-${randomUUID()}`],
      );
      const category = await client.query(
        `INSERT INTO catalogue.categories (code, name) VALUES ($1, 'REN2-50 Synthetic') RETURNING id`,
        [`ren2-50-${randomUUID()}`],
      );
      await client.query(
        `INSERT INTO catalogue.category_schema_versions
           (category_id, version, ruleset_sha256, validator_version)
         VALUES ($1, 1, repeat('a', 64), 'ren2-50-test') RETURNING id`,
        [category.rows[0].id],
      );

      await client.query('SAVEPOINT invalid_brand_fk');
      await assert.rejects(
        client.query(
          `INSERT INTO catalogue.products (brand_id, category_id, style_code, title, category_schema_version)
           VALUES ($1, $2, 'BAD-BRAND', 'Invalid brand fixture', 1)`,
          [randomUUID(), category.rows[0].id],
        ),
        (error) => error.code === '23503',
        'product writes must reject an unknown W1 brand ID',
      );
      await client.query('ROLLBACK TO SAVEPOINT invalid_brand_fk');
      await client.query('RELEASE SAVEPOINT invalid_brand_fk');

      const product = await client.query(
        `INSERT INTO catalogue.products (brand_id, category_id, style_code, title, category_schema_version)
         VALUES ($1, $2, 'REN2-50-STYLE', 'Valid fixture', 1) RETURNING id`,
        [brand.rows[0].id, category.rows[0].id],
      );
      assert.match(product.rows[0].id, /^[0-9a-f-]{36}$/i, 'product IDs must be UUIDs');
      await client.query('SAVEPOINT invalid_category_schema_pin');
      await assert.rejects(
        client.query(
          `INSERT INTO catalogue.products (brand_id, category_id, style_code, title, category_schema_version)
           VALUES ($1, $2, 'REN2-60-BAD-PIN', 'Invalid schema pin fixture', 99)`,
          [brand.rows[0].id, category.rows[0].id],
        ),
        (error) => error.code === '23503',
        'a product must reference an existing version of its selected category',
      );
      await client.query('ROLLBACK TO SAVEPOINT invalid_category_schema_pin');
      await client.query('RELEASE SAVEPOINT invalid_category_schema_pin');
      const variant = await client.query(
        `INSERT INTO catalogue.product_variants
           (brand_id, product_id, sku, option_signature, options)
         VALUES ($1, $2, 'REN2-50-SKU', 'default', '{}'::jsonb) RETURNING id`,
        [brand.rows[0].id, product.rows[0].id],
      );

      const location = await client.query(`INSERT INTO inventory.stock_locations(brand_id,location_code,name)
        VALUES($1,'REN2-50-WH','REN2-50 Warehouse') RETURNING id`, [brand.rows[0].id]);
      await client.query(`INSERT INTO inventory.stock_balances(brand_id,variant_id,location_id)
        VALUES($1,$2,$3)`, [brand.rows[0].id, variant.rows[0].id, location.rows[0].id]);
      const zeroPool = await client.query(`SELECT physical_on_hand,quarantined,allocated_not_dispatched,pre_commit_allocations,safety_buffer,row_version
        FROM inventory.stock_balances WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3`,
      [brand.rows[0].id, variant.rows[0].id, location.rows[0].id]);
      assert.deepEqual(zeroPool.rows[0], { physical_on_hand: '0', quarantined: '0', allocated_not_dispatched: '0', pre_commit_allocations: '0', safety_buffer: '0', row_version: '1' },
        'new brand + SKU + location pools must start empty at genesis version 1');
      await client.query('SAVEPOINT invalid_physical_stock_invariant');
      await assert.rejects(client.query(`UPDATE inventory.stock_balances SET physical_on_hand=1,quarantined=1,allocated_not_dispatched=1
        WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3`, [brand.rows[0].id, variant.rows[0].id, location.rows[0].id]),
      (error) => error.code === '23514', 'physical stock must cover quarantined and committed units');
      await client.query('ROLLBACK TO SAVEPOINT invalid_physical_stock_invariant');
      await client.query('RELEASE SAVEPOINT invalid_physical_stock_invariant');

      await client.query('SAVEPOINT event_missing_detail');
      const missingDetailId = randomUUID();
      await client.query(`INSERT INTO inventory.stock_events(id,brand_id,variant_id,location_id,pool_sequence,event_kind,business_effect_key,payload_sha256,
        delta_physical,before_balance,after_balance) VALUES($1,$2,$3,$4,2,'PHYSICAL','missing-detail',repeat('a',64),1,'{}','{}')`,
      [missingDetailId, brand.rows[0].id, variant.rows[0].id, location.rows[0].id]);
      await assert.rejects(client.query('SET CONSTRAINTS ALL IMMEDIATE'),
        /STOCK_EVENT_REQUIRES_EXACTLY_ONE_TYPED_DETAIL/, 'every stock event requires exactly one typed journal detail');
      await client.query('ROLLBACK TO SAVEPOINT event_missing_detail');
      await client.query('RELEASE SAVEPOINT event_missing_detail');
      await client.query('SET CONSTRAINTS ALL DEFERRED');

      await client.query('SAVEPOINT event_with_detail');
      const eventId = randomUUID();
      await client.query(`INSERT INTO inventory.stock_events(id,brand_id,variant_id,location_id,pool_sequence,event_kind,business_effect_key,payload_sha256,
        delta_physical,before_balance,after_balance) VALUES($1,$2,$3,$4,2,'PHYSICAL','valid-detail',repeat('b',64),1,'{}','{}')`,
      [eventId, brand.rows[0].id, variant.rows[0].id, location.rows[0].id]);
      await client.query(`INSERT INTO inventory.stock_movements(stock_event_id,brand_id,variant_id,location_id,delta_physical,movement_reason,
        business_effect_key,source_type,source_reference,balance_version_after)
        VALUES($1,$2,$3,$4,1,'TEST_RECEIPT','valid-detail','TEST','fixture',2)`,
      [eventId, brand.rows[0].id, variant.rows[0].id, location.rows[0].id]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query('ROLLBACK TO SAVEPOINT event_with_detail');
      await client.query('RELEASE SAVEPOINT event_with_detail');
      await client.query('SET CONSTRAINTS ALL DEFERRED');

      const otherProduct = await client.query(
        `INSERT INTO catalogue.products (brand_id, category_id, style_code, title, category_schema_version)
         VALUES ($1, $2, 'REN2-60-STYLE', 'Other brand fixture', 1) RETURNING id`,
        [otherBrand.rows[0].id, category.rows[0].id],
      );
      const sameSkuOtherBrand = await client.query(
        `INSERT INTO catalogue.product_variants
           (brand_id, product_id, sku, option_signature, options)
         VALUES ($1, $2, 'REN2-50-SKU', 'default', '{}'::jsonb) RETURNING id`,
        [otherBrand.rows[0].id, otherProduct.rows[0].id],
      );
      assert.ok(sameSkuOtherBrand.rows[0].id, 'same SKU must be valid for a different brand');

      await client.query('SAVEPOINT duplicate_brand_sku');
      await assert.rejects(
        client.query(
          `INSERT INTO catalogue.product_variants
             (brand_id, product_id, sku, option_signature, options)
           VALUES ($1, $2, 'ren2-50-sku', 'other', '{}'::jsonb)`,
          [brand.rows[0].id, product.rows[0].id],
        ),
        (error) => error.code === '23505',
        'SKU uniqueness must be normalized and scoped to one brand',
      );
      await client.query('ROLLBACK TO SAVEPOINT duplicate_brand_sku');
      await client.query('RELEASE SAVEPOINT duplicate_brand_sku');

      await client.query('SAVEPOINT cross_brand_product');
      await assert.rejects(
        client.query(
          `INSERT INTO catalogue.product_variants
             (brand_id, product_id, sku, option_signature, options)
           VALUES ($1, $2, 'REN2-60-CROSS', 'cross', '{}'::jsonb)`,
          [otherBrand.rows[0].id, product.rows[0].id],
        ),
        (error) => error.code === '23503',
        'a variant must reference a product from the same brand',
      );
      await client.query('ROLLBACK TO SAVEPOINT cross_brand_product');
      await client.query('RELEASE SAVEPOINT cross_brand_product');

      await client.query('SAVEPOINT duplicate_option_signature');
      await assert.rejects(
        client.query(
          `INSERT INTO catalogue.product_variants
             (brand_id, product_id, sku, option_signature, options)
           VALUES ($1, $2, 'REN2-60-DUP-SIG', 'default', '{}'::jsonb)`,
          [brand.rows[0].id, product.rows[0].id],
        ),
        (error) => error.code === '23505',
        'one product must not contain duplicate canonical option signatures',
      );
      await client.query('ROLLBACK TO SAVEPOINT duplicate_option_signature');
      await client.query('RELEASE SAVEPOINT duplicate_option_signature');

      await client.query('SAVEPOINT duplicate_style_code');
      await assert.rejects(
        client.query(
          `INSERT INTO catalogue.products (brand_id, category_id, style_code, title, category_schema_version)
           VALUES ($1, $2, ' ren2-50-style ', 'Duplicate style fixture', 1)`,
          [brand.rows[0].id, category.rows[0].id],
        ),
        (error) => error.code === '23505',
        'style code uniqueness must use its normalized value within one brand',
      );
      await client.query('ROLLBACK TO SAVEPOINT duplicate_style_code');
      await client.query('RELEASE SAVEPOINT duplicate_style_code');

      await client.query(`UPDATE catalogue.product_variants SET sku_locked_at = now() WHERE id = $1`, [variant.rows[0].id]);
      await client.query('SAVEPOINT ordered_sku_immutable');
      await assert.rejects(
        client.query(`UPDATE catalogue.product_variants SET sku = 'REN2-60-CHANGED' WHERE id = $1`, [variant.rows[0].id]),
        (error) => error.code === '23514',
        'an ordered variant SKU must be immutable',
      );
      await client.query('ROLLBACK TO SAVEPOINT ordered_sku_immutable');
      await client.query('RELEASE SAVEPOINT ordered_sku_immutable');

      await client.query('SAVEPOINT ordered_sku_lock_immutable');
      await assert.rejects(
        client.query(`UPDATE catalogue.product_variants SET sku_locked_at = NULL WHERE id = $1`, [variant.rows[0].id]),
        (error) => error.code === '23514',
        'an ordered variant SKU lock must not be cleared',
      );
      await client.query('ROLLBACK TO SAVEPOINT ordered_sku_lock_immutable');
      await client.query('RELEASE SAVEPOINT ordered_sku_lock_immutable');

      await client.query('SAVEPOINT ordered_sku_lock_rewrite');
      await assert.rejects(
        client.query(`UPDATE catalogue.product_variants SET sku_locked_at = now() + interval '1 second' WHERE id = $1`, [variant.rows[0].id]),
        (error) => error.code === '23514',
        'an ordered variant lock timestamp must not be rewritten',
      );
      await client.query('ROLLBACK TO SAVEPOINT ordered_sku_lock_rewrite');
      await client.query('RELEASE SAVEPOINT ordered_sku_lock_rewrite');
      await client.query(
        `INSERT INTO catalogue.variant_prices
           (brand_id, variant_id, amount_minor, mrp_minor, valid_from, valid_to, price_state, rule_version)
         VALUES ($1, $2, 100, 200, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 'APPROVED', 1)`,
        [brand.rows[0].id, variant.rows[0].id],
      );
      await client.query(
        `INSERT INTO catalogue.variant_prices
           (brand_id, variant_id, amount_minor, mrp_minor, valid_from, valid_to, price_state, rule_version)
         VALUES ($1, $2, 100, 200, '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z', 'APPROVED', 2)`,
        [brand.rows[0].id, variant.rows[0].id],
      );
      await client.query('SAVEPOINT overlapping_price');
      await assert.rejects(
        client.query(
          `INSERT INTO catalogue.variant_prices
             (brand_id, variant_id, amount_minor, mrp_minor, valid_from, valid_to, price_state, rule_version)
           VALUES ($1, $2, 100, 200, '2026-01-15T00:00:00Z', '2026-01-20T00:00:00Z', 'APPROVED', 3)`,
          [brand.rows[0].id, variant.rows[0].id],
        ),
        (error) => error.code === '23P01',
        'overlapping approved prices must be rejected',
      );
      await client.query('ROLLBACK TO SAVEPOINT overlapping_price');
      await client.query('RELEASE SAVEPOINT overlapping_price');
    } finally {
      await client.query('ROLLBACK');
    }

    assert.deepEqual(await w1SchemaSignature(client), w1Before, 'fixture rollback must leave W1 schemas unchanged');
  } finally {
    client.release();
    await pool.end();
  }
});

