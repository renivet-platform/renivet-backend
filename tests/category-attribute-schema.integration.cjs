'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const {
  compileCategorySchema,
  SUPPORTED_CATEGORY_VALIDATOR_VERSION,
} = require('../dist/modules/catalog/category-attribute-validator.js');

function disposableUrl() {
  const value = process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required for category schema integration tests');
  const url = new URL(value);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1', 'category schema tests require loopback-only PostgreSQL');
  assert.equal(url.pathname, '/renivet_ci');
  assert.equal(url.username, 'renivet_ci');
  return value;
}

async function createVersion(client, categoryId, version, actorId, { includeConditionalRule }) {
  const versionRow = await client.query(
    `INSERT INTO catalogue.category_schema_versions
       (category_id, version, ruleset_sha256, validator_version)
     VALUES ($1, $2, repeat('a', 64), $3) RETURNING id`,
    [categoryId, version, SUPPORTED_CATEGORY_VALIDATOR_VERSION],
  );
  const schemaVersionId = versionRow.rows[0].id;
  const productTypeAttribute = await client.query(
    `INSERT INTO catalogue.attributes (code, label, value_type, scope_type)
     VALUES ($1, 'Product type', 'enum', 'product') RETURNING id, code`,
    [`r57-product-type-${version}-${randomUUID()}`],
  );
  const productTypeRule = await client.query(
    `INSERT INTO catalogue.category_schema_attribute_rules
       (schema_version_id, attribute_id, attribute_code, scope_type, value_type, allowed_values)
     VALUES ($1, $2, 'productType', 'product', 'enum', '["shirt","trouser"]'::jsonb)
     RETURNING id, attribute_id, attribute_code, scope_type, value_type, allowed_values,
               unit_code, required_by_default, conditional_ast, min_values, max_values`,
    [schemaVersionId, productTypeAttribute.rows[0].id],
  );
  const rows = [productTypeRule.rows[0]];
  let variantRuleId;
  let variantAttributeId;
  if (includeConditionalRule) {
    const lengthAttribute = await client.query(
      `INSERT INTO catalogue.attributes (code, label, value_type, scope_type)
       VALUES ($1, 'Sleeve length', 'measurement', 'product') RETURNING id`,
      [`r57-sleeve-length-${version}-${randomUUID()}`],
    );
    const lengthRule = await client.query(
      `INSERT INTO catalogue.category_schema_attribute_rules
         (schema_version_id, attribute_id, attribute_code, scope_type, value_type, unit_code,
          conditional_ast, required_by_default)
       VALUES ($1, $2, 'sleeveLength', 'product', 'measurement', 'cm',
               '{"version":1,"root":{"op":"eq","field":"productType","value":"shirt"}}'::jsonb, false)
       RETURNING id, attribute_id, attribute_code, scope_type, value_type, allowed_values,
                 unit_code, required_by_default, conditional_ast, min_values, max_values`,
      [schemaVersionId, lengthAttribute.rows[0].id],
    );
    rows.push(lengthRule.rows[0]);

    const variantAttribute = await client.query(
      `INSERT INTO catalogue.attributes (code, label, value_type, scope_type)
       VALUES ($1, 'Variant color', 'enum', 'variant') RETURNING id`,
      [`r57-variant-color-${version}-${randomUUID()}`],
    );
    const variantRule = await client.query(
      `INSERT INTO catalogue.category_schema_attribute_rules
         (schema_version_id, attribute_id, attribute_code, scope_type, value_type, allowed_values)
       VALUES ($1, $2, 'variantColor', 'variant', 'enum', '["blue","red"]'::jsonb) RETURNING id, attribute_id`,
      [schemaVersionId, variantAttribute.rows[0].id],
    );
    variantRuleId = variantRule.rows[0].id;
    variantAttributeId = variantRule.rows[0].attribute_id;
    rows.push({
      ...variantRule.rows[0],
      attribute_code: 'variantColor',
      scope_type: 'variant',
      value_type: 'enum',
      allowed_values: ['blue', 'red'],
      unit_code: null,
      required_by_default: false,
      conditional_ast: null,
      min_values: null,
      max_values: null,
    });
  }
  await client.query(
    `UPDATE catalogue.category_schema_versions
        SET state='PUBLISHED', approved_by=$2, published_at=now()
      WHERE id=$1`,
    [schemaVersionId, actorId],
  );
  return { id: schemaVersionId, rules: rows, variantRuleId, variantAttributeId };
}

test('REN2-57 validates the schema snapshot pinned to a revision and enforces frozen value scope in PostgreSQL', {
  timeout: 60_000,
  skip: !process.env.RENIVET_TEST_DATABASE_URL,
}, async (t) => {
  const pool = new Pool({ connectionString: disposableUrl(), max: 2, connectionTimeoutMillis: 5_000 });
  t.after(() => pool.end());
  const server = await pool.query('SHOW server_version_num');
  const versionNumber = Number(server.rows[0].server_version_num);
  assert.ok(versionNumber >= 160000 && versionNumber < 170000, 'REN2-57 requires disposable PostgreSQL 16');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = await client.query(
      `INSERT INTO identity.users (email, display_name, state)
       VALUES ($1, 'REN2-57 Synthetic Approver', 'ACTIVE') RETURNING id`,
      [`r57-${randomUUID()}@example.invalid`],
    );
    const category = await client.query(
      `INSERT INTO catalogue.categories (code, name)
       VALUES ($1, 'REN2-57 Synthetic Category') RETURNING id`,
      [`r57-${randomUUID()}`],
    );
    const v1 = await createVersion(client, category.rows[0].id, 1, actor.rows[0].id, { includeConditionalRule: false });
    const v2 = await createVersion(client, category.rows[0].id, 2, actor.rows[0].id, { includeConditionalRule: true });

    const compile = async (schemaVersion) => {
      const loaded = await client.query(
        `SELECT v.id AS schema_version_id, v.category_id, v.version, v.validator_version,
                r.id, r.attribute_id, r.attribute_code, r.scope_type, r.value_type, r.allowed_values,
                r.unit_code, r.required_by_default, r.conditional_ast, r.min_values, r.max_values
           FROM catalogue.category_schema_versions v
           JOIN catalogue.category_schema_attribute_rules r ON r.schema_version_id=v.id
          WHERE v.id=$1 AND v.state='PUBLISHED' ORDER BY r.attribute_code`,
        [schemaVersion.id],
      );
      return compileCategorySchema({
        categoryId: loaded.rows[0].category_id,
        categorySchemaVersionId: loaded.rows[0].schema_version_id,
        categorySchemaVersion: loaded.rows[0].version,
        validatorVersion: loaded.rows[0].validator_version,
        rules: loaded.rows.map((row) => ({
          id: row.id,
          attributeId: row.attribute_id,
          code: row.attribute_code,
          scope: row.scope_type,
          valueType: row.value_type,
          allowedValues: row.allowed_values,
          unitCode: row.unit_code,
          requiredByDefault: row.required_by_default,
          conditionalAst: row.conditional_ast,
          minValues: row.min_values,
          maxValues: row.max_values,
        })),
      });
    };
    const v1Validator = await compile(v1);
    const v2Validator = await compile(v2);
    const oldRevision = { product: { productType: 'shirt' } };
    assert.equal(v1Validator.validate(oldRevision).valid, true);
    const newRevision = v2Validator.validate(oldRevision);
    assert.equal(newRevision.valid, false);
    assert.equal(newRevision.categorySchemaVersion, 2);
    assert.equal(newRevision.validatorVersion, SUPPORTED_CATEGORY_VALIDATOR_VERSION);

    const brand = await client.query(
      `INSERT INTO brands.brands (slug, legal_name, display_name, onboarding_state)
       VALUES ($1, 'REN2-57 Synthetic Ltd', 'REN2-57 Synthetic', 'approved') RETURNING id`,
      [`r57-${randomUUID()}`],
    );
    const oldProduct = await client.query(
      `INSERT INTO catalogue.products (brand_id, category_id, style_code, title, category_schema_version)
       VALUES ($1, $2, $3, 'REN2-57 Product pinned to v1', 1) RETURNING id`,
      [brand.rows[0].id, category.rows[0].id, `R57-${randomUUID()}`],
    );
    const currentProduct = await client.query(
      `INSERT INTO catalogue.products (brand_id, category_id, style_code, title, category_schema_version)
       VALUES ($1, $2, $3, 'REN2-57 Product pinned to v2', 2) RETURNING id`,
      [brand.rows[0].id, category.rows[0].id, `R57-${randomUUID()}`],
    );
    const oldPin = await client.query('SELECT category_schema_version FROM catalogue.products WHERE id=$1', [oldProduct.rows[0].id]);
    assert.equal(oldPin.rows[0].category_schema_version, 1, 'publishing v2 cannot rewrite a product pinned to v1');
    const persistedRevision = await client.query(
      `INSERT INTO catalogue.product_revisions
         (brand_id, product_id, content_version, content_snapshot, content_sha256, submitted_by, category_id, category_schema_version)
       VALUES ($1, $2, 1, '{"productType":"shirt"}'::jsonb, repeat('c', 64), $3, $4, 1)
       RETURNING id, category_schema_version`,
      [brand.rows[0].id, oldProduct.rows[0].id, actor.rows[0].id, category.rows[0].id],
    );
    assert.equal(persistedRevision.rows[0].category_schema_version, 1, 'the immutable revision keeps its submitted schema version');
    assert.equal(v1Validator.categorySchemaVersion, persistedRevision.rows[0].category_schema_version);
    assert.equal(v1Validator.categorySchemaVersionId, v1.id);
    await client.query('SAVEPOINT cross_scope_value');
    await assert.rejects(
      client.query(
        `INSERT INTO catalogue.product_attribute_values
           (brand_id, product_id, category_id, category_schema_version, attribute_id,
            schema_version_id, frozen_rule_id, val_enum)
         VALUES ($1, $2, $3, 2, $4, $5, $6, 'blue')`,
        [brand.rows[0].id, currentProduct.rows[0].id, category.rows[0].id,
          v2.variantAttributeId, v2.id, v2.variantRuleId],
      ),
      (error) => error.code === '23503',
      'a product attribute row cannot bind to a frozen variant-scoped rule',
    );
    await client.query('ROLLBACK TO SAVEPOINT cross_scope_value');
    await client.query('RELEASE SAVEPOINT cross_scope_value');

    const otherBrand = await client.query(
      `INSERT INTO brands.brands (slug, legal_name, display_name, onboarding_state)
       VALUES ($1, 'REN2-57 Other Synthetic Ltd', 'REN2-57 Other Synthetic', 'approved') RETURNING id`,
      [`r57-other-${randomUUID()}`],
    );
    const productTypeRule = v2.rules.find((row) => row.attribute_code === 'productType');
    await client.query('SAVEPOINT cross_brand_value');
    await assert.rejects(
      client.query(
        `INSERT INTO catalogue.product_attribute_values
           (brand_id, product_id, category_id, category_schema_version, attribute_id,
            schema_version_id, frozen_rule_id, val_enum)
         VALUES ($1, $2, $3, 2, $4, $5, $6, 'shirt')`,
        [otherBrand.rows[0].id, currentProduct.rows[0].id, category.rows[0].id,
          productTypeRule.attribute_id, v2.id, productTypeRule.id],
      ),
      (error) => error.code === '23503',
      'a second brand cannot attach attribute values to the first brand product',
    );
    await client.query('ROLLBACK TO SAVEPOINT cross_brand_value');
    await client.query('RELEASE SAVEPOINT cross_brand_value');

    await assert.rejects(
      client.query(`UPDATE catalogue.category_schema_versions SET validator_version='tampered-v9' WHERE id=$1`, [v1.id]),
      (error) => error.code === '23514',
      'the validator version is part of the published immutable schema pin',
    );
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});
