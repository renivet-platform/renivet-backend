'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool, Client } = require('pg');
const test = require('node:test');

function databaseUrl() {
  const raw = process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(raw, 'RENIVET_TEST_DATABASE_URL is required for disposable migration acceptance');
  const url = new URL(raw);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/renivet_ci');
  assert.equal(url.username, 'renivet_ci');
  return url;
}

const migrations = fs.readdirSync(path.join(__dirname, '..', 'drizzle'))
  .filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();

async function applyMigration(client, filename) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'drizzle', filename), 'utf8');
  await client.query('BEGIN');
  try {
    for (const statement of sql.split(/--> statement-breakpoint/g)) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    error.message = `${filename}: ${error.message}`;
    throw error;
  }
}

async function w1SchemaSignature(client) {
  const result = await client.query(`SELECT table_schema, table_name, ordinal_position,
      column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema IN ('identity','platform','brands','access')
    ORDER BY table_schema,table_name,ordinal_position`);
  return result.rows;
}

test('REN2-103 replays staged W2 migrations, preserves W1 schema, and verifies historical backfills', {
  timeout: 120_000,
  skip: !process.env.RENIVET_TEST_DATABASE_URL,
}, async (t) => {
  const source = databaseUrl();
  const adminUrl = new URL(source);
  adminUrl.pathname = '/postgres';
  const database = `ren2_103_backfill_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1, connectionTimeoutMillis: 5000 });
  const role = await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
  assert.equal(role.rows[0]?.rolsuper, true, 'migration acceptance needs the disposable CI superuser to create an isolated database');
  await admin.query(`CREATE DATABASE ${database} TEMPLATE template0`);
  const isolatedUrl = new URL(source);
  isolatedUrl.pathname = `/${database}`;
  const client = new Client({ connectionString: isolatedUrl.toString(), connectionTimeoutMillis: 5000 });
  t.after(async () => {
    await client.end().catch(() => {});
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`).catch(() => {});
    await admin.end();
  });
  await client.connect();

  const w1MigrationCount = 6;
  for (const filename of migrations.slice(0, w1MigrationCount)) await applyMigration(client, filename);
  const w1Before = await w1SchemaSignature(client);
  const w1Tables = new Set(w1Before.map((row) => `${row.table_schema}.${row.table_name}`));
  for (const filename of migrations.slice(w1MigrationCount, 14)) await applyMigration(client, filename);

  const suffix = randomUUID().replaceAll('-', '');
  const actor = (await client.query(
    `INSERT INTO identity.users(email,state) VALUES($1,'active') RETURNING id`, [`ren2-103-${suffix}@example.test`],
  )).rows[0].id;
  const brand = (await client.query(
    `INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
     VALUES($1,'REN2-103 legacy','REN2-103 legacy','approved') RETURNING id`, [`ren2-103-${suffix}`],
  )).rows[0].id;
  const category = (await client.query(
    `INSERT INTO catalogue.categories(code,name) VALUES($1,'REN2-103 backfill') RETURNING id`, [`ren2-103-${suffix}`],
  )).rows[0].id;
  const attribute = (await client.query(
    `INSERT INTO catalogue.attributes(code,label,value_type,scope_type)
     VALUES($1,'Legacy display label','text','product') RETURNING id`, [`ren2-103-${suffix}`],
  )).rows[0].id;
  const schema = (await client.query(
    `INSERT INTO catalogue.category_schema_versions(category_id,version,state,ruleset,ruleset_sha256,validator_version)
     VALUES($1,1,'DRAFT','{}'::jsonb,repeat('0',64),'ren2-103-legacy') RETURNING id`, [category],
  )).rows[0].id;
  const rule = (await client.query(
    `INSERT INTO catalogue.category_schema_attribute_rules(schema_version_id,attribute_id,attribute_code,scope_type,value_type)
     VALUES($1,$2,$3,'product','text') RETURNING id`, [schema, attribute, `ren2-103-${suffix}`],
  )).rows[0].id;
  const product = (await client.query(
    `INSERT INTO catalogue.products(brand_id,category_id,style_code,title,category_schema_version)
     VALUES($1,$2,$3,'Legacy product',1) RETURNING id`, [brand, category, `REN2-103-${suffix}`],
  )).rows[0].id;
  const revision = (await client.query(
    `INSERT INTO catalogue.product_revisions(brand_id,product_id,content_version,content_snapshot,content_sha256,submitted_by,category_id,category_schema_version)
     VALUES($1,$2,1,'{}'::jsonb,repeat('a',64),$3,$4,1) RETURNING id`, [brand, product, actor, category],
  )).rows[0].id;
  const claim = (await client.query(
    `INSERT INTO catalogue.sustainability_claims(brand_id,product_id,revision_id,claim_code,claim_text)
     VALUES($1,$2,$3,'RECYCLED','Legacy claim') RETURNING id`, [brand, product, revision],
  )).rows[0].id;

  for (const filename of migrations.slice(14)) await applyMigration(client, filename);

  const label = await client.query('SELECT display_label FROM catalogue.category_schema_attribute_rules WHERE id=$1', [rule]);
  assert.equal(label.rows[0].display_label, 'Legacy display label', 'REN2-63 must backfill frozen attribute labels from the source attribute');
  const hash = await client.query(
    'SELECT ruleset_sha256=catalogue.category_schema_content_sha256(id,ruleset,validator_version) AS matches FROM catalogue.category_schema_versions WHERE id=$1', [schema],
  );
  assert.equal(hash.rows[0].matches, true, 'REN2-63 must recompute the schema hash after label backfill');
  const submitter = await client.query('SELECT submitted_by FROM catalogue.sustainability_claims WHERE id=$1', [claim]);
  assert.equal(submitter.rows[0].submitted_by, actor, 'REN2-69 must recover the claim submitter from its immutable product revision');
  const w1After = (await w1SchemaSignature(client)).filter((row) => w1Tables.has(`${row.table_schema}.${row.table_name}`));
  assert.deepEqual(w1After, w1Before, 'W2 migrations must not alter existing W1 identity, platform, brand or access tables');
  for (const filename of migrations.slice(w1MigrationCount)) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'drizzle', filename), 'utf8');
    assert.doesNotMatch(sql, /^\s*ALTER\s+TABLE\s+(?:identity|platform|brands|access)\./im,
      `${filename} must not alter a W1-owned table`);
  }
  assert.equal(migrations.length, 41, 'the staged test must cover the complete checked-in migration chain');
});

test('REN2-103 applied migration ledger has no content or timestamp drift', {
  skip: !process.env.RENIVET_TEST_DATABASE_URL,
}, async () => {
  const source = databaseUrl();
  const pool = new Pool({ connectionString: source.toString(), max: 1, connectionTimeoutMillis: 5000 });
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'drizzle/meta/_journal.json'), 'utf8')).entries;
    const applied = await pool.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at');
    assert.equal(entries.length, migrations.length);
    assert.equal(applied.rowCount, migrations.length);
    for (let index = 0; index < migrations.length; index += 1) {
      const filename = migrations[index];
      const digest = createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'drizzle', filename))).digest('hex');
      assert.equal(applied.rows[index].hash, digest, `${filename} changed after it was recorded as applied`);
      assert.equal(String(applied.rows[index].created_at), String(entries[index].when), `${filename} journal timestamp/order drift`);
    }
  } finally {
    await pool.end();
  }
});
