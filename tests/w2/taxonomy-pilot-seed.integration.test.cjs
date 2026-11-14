'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');

const url = process.env.RENIVET_TEST_DATABASE_URL;
const fixturePath = join(__dirname, '../../src/modules/catalog/taxonomy/apparel-pilot-v1.json');

test('REN2-54 Pilot v1 is persisted by stable IDs, hash-locked, and inactive until maker-checker publication', {
  skip: url ? false : 'requires disposable PostgreSQL 16', timeout: 30_000,
}, async (t) => {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, '/renivet_ci');
  assert.equal(parsed.username, 'renivet_ci');
  const pool = new Pool({ connectionString: url, max: 2 });
  t.after(() => pool.end());
  const dataset = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const hash = createHash('sha256').update(readFileSync(fixturePath)).digest('hex');
  const persistedDataset = (await pool.query(
    `SELECT owner,source_sha256 FROM catalogue.taxonomy_seed_datasets
      WHERE dataset_id=$1 AND version=$2`, [dataset.datasetId, dataset.version],
  )).rows[0];
  assert.deepEqual(persistedDataset, { owner: 'Catalog Operations', source_sha256: hash });

  const categories = (await pool.query(
    `SELECT id,code,parent_id,active,schema_version FROM catalogue.categories
      WHERE code=ANY($1::text[]) ORDER BY code`, [dataset.categories.map(({ code }) => code)],
  )).rows;
  assert.equal(categories.length, 8);
  assert.deepEqual(new Set(categories.map(({ id }) => id)), new Set(dataset.categories.map(({ id }) => id)));
  assert.ok(categories.every(({ active, schema_version }) => active === false && schema_version === null), 'seeded leaf categories must remain inactive until the guarded publish flow');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalogue.categories WHERE code='apparel' AND parent_id IS NULL")).rows[0].n, 1);

  const attributeCodes = [...new Set(dataset.categories.flatMap(({ attributes }) => attributes.map(({ code }) => code)))];
  const attributes = (await pool.query(
    `SELECT id,code,value_type,scope_type FROM catalogue.attributes WHERE code=ANY($1::text[])`, [attributeCodes],
  )).rows;
  assert.equal(attributes.length, attributeCodes.length);
  for (const attribute of attributes) {
    const expected = dataset.categories.flatMap(({ attributes: rules }) => rules).find(({ code }) => code === attribute.code);
    assert.equal(attribute.id, expected.id);
    assert.equal(attribute.value_type, expected.valueType);
    assert.equal(attribute.scope_type, expected.scope);
  }
  assert.equal((await pool.query(
    `SELECT count(*)::int AS n FROM catalogue.category_schema_versions v
      JOIN catalogue.categories c ON c.id=v.category_id WHERE c.code=ANY($1::text[])`, [dataset.categories.map(({ code }) => code)],
  )).rows[0].n, 0, 'seed import must not publish or create an unreviewed schema version');
});
