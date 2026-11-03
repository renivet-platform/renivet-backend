'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');

function disposableDatabaseUrl() {
  const value = process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required for PostgreSQL 16 taxonomy integration tests');
  const url = new URL(value);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1', 'taxonomy integration database must be loopback only');
  assert.equal(url.pathname, '/renivet_ci');
  assert.equal(url.username, 'renivet_ci');
  return value;
}

async function insertActor(pool, tag) {
  const result = await pool.query(
    `INSERT INTO identity.users (email, display_name, state)
     VALUES ($1, 'REN2-56 Taxonomy Approver', 'ACTIVE') RETURNING id`,
    [`ren2-56-${tag}@example.invalid`],
  );
  return result.rows[0].id;
}

async function insertCategory(pool, tag, parentId = null) {
  const result = await pool.query(
    `INSERT INTO catalogue.categories (parent_id, code, name)
     VALUES ($1, $2, 'REN2-56 Synthetic Category') RETURNING id, parent_id, active, schema_version`,
    [parentId, `ren2-56-${tag}`],
  );
  return result.rows[0];
}

async function insertVersion(pool, categoryId, version, actorId, rule) {
  const result = await pool.query(
    `INSERT INTO catalogue.category_schema_versions
       (category_id, version, ruleset, ruleset_sha256, validator_version, approved_by)
     VALUES ($1, $2, '{"purpose":"taxonomy-test"}'::jsonb, repeat('a', 64), 'ren2-56-test-v1', NULL)
     RETURNING id`,
    [categoryId, version],
  );
  if (rule) {
    const attribute = await pool.query(
      `INSERT INTO catalogue.attributes (code, label, value_type, scope_type)
       VALUES ($1, 'Taxonomy test attribute', 'text', 'product') RETURNING id`,
      [`ren2-56-attribute-${categoryId}-${version}`],
    );
    await pool.query(
      `INSERT INTO catalogue.category_schema_attribute_rules
         (schema_version_id, attribute_id, attribute_code, scope_type, value_type, required_by_default)
       VALUES ($1, $2, 'testAttribute', 'product', 'text', $3)`,
      [result.rows[0].id, attribute.rows[0].id, rule.required ?? false],
    );
  }
  if (actorId && rule?.publish) {
    await pool.query(
      `UPDATE catalogue.category_schema_versions
          SET state='PUBLISHED', approved_by=$2, published_at=now()
        WHERE id=$1`,
      [result.rows[0].id, actorId],
    );
  }
  return result.rows[0].id;
}

test('REN2-56 enforces canonical taxonomy lifecycle and exact immutable version pins', {
  timeout: 60_000,
  skip: !process.env.RENIVET_TEST_DATABASE_URL,
}, async (t) => {
  const pool = new Pool({ connectionString: disposableDatabaseUrl(), max: 8, connectionTimeoutMillis: 5_000 });
  t.after(() => pool.end());
  const version = await pool.query('SHOW server_version_num');
  const versionNumber = Number(version.rows[0].server_version_num);
  assert.ok(versionNumber >= 160000 && versionNumber < 170000, 'REN2-56 requires disposable PostgreSQL 16');

  await t.test('new nodes are unavailable until schema publication and categories cannot cycle or publish as parents', async () => {
    const actorId = await insertActor(pool, randomUUID());
    const parent = await insertCategory(pool, randomUUID());
    assert.equal(parent.active, false, 'new taxonomy nodes must default to inactive');
    assert.equal(parent.schema_version, null, 'a node without a published schema must have no current-version pointer');

    const child = await insertCategory(pool, randomUUID(), parent.id);
    await assert.rejects(
      pool.query('UPDATE catalogue.categories SET parent_id=$2 WHERE id=$1', [parent.id, child.id]),
      (error) => error.code === '23514',
      'a cycle in the shared category tree must be rejected',
    );

    const nonLeaf = await insertVersion(pool, parent.id, 1, null, null);
    await assert.rejects(
      pool.query(
        `UPDATE catalogue.category_schema_versions
            SET state='PUBLISHED', approved_by=$2, published_at=now()
          WHERE id=$1`,
        [nonLeaf, actorId],
      ),
      (error) => error.code === '23514',
      'a category with children cannot publish a schema',
    );
    const status = await pool.query('SELECT state FROM catalogue.category_schema_versions WHERE id=$1', [nonLeaf]);
    assert.equal(status.rows[0].state, 'DRAFT');
  });

  await t.test('concurrent tree edits cannot create a cycle', async () => {
    const left = await insertCategory(pool, randomUUID());
    const right = await insertCategory(pool, randomUUID());
    const outcomes = await Promise.allSettled([
      pool.query('UPDATE catalogue.categories SET parent_id=$2 WHERE id=$1', [left.id, right.id]),
      pool.query('UPDATE catalogue.categories SET parent_id=$2 WHERE id=$1', [right.id, left.id]),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
    const cycle = await pool.query(
      `WITH RECURSIVE walk(start_id, id, parent_id, visited, is_cycle) AS (
         SELECT id, id, parent_id, ARRAY[id]::uuid[], false FROM catalogue.categories WHERE id = ANY($1::uuid[])
         UNION ALL
         SELECT w.start_id, p.id, p.parent_id, w.visited || p.id, p.id = ANY(w.visited)
           FROM walk w JOIN catalogue.categories p ON p.id = w.parent_id
          WHERE NOT w.is_cycle
       ) SELECT bool_or(is_cycle) AS has_cycle FROM walk WHERE start_id = ANY($1::uuid[])`,
      [[left.id, right.id]],
    );
    assert.equal(cycle.rows[0].has_cycle, false);
  });

  await t.test('publishing freezes version rules, computes a content hash, and advances one exact pointer', async () => {
    const actorId = await insertActor(pool, randomUUID());
    const category = await insertCategory(pool, randomUUID());
    const v1 = await insertVersion(pool, category.id, 1, null, { required: false });
    await pool.query(
      `UPDATE catalogue.category_schema_versions
          SET state='PUBLISHED', approved_by=$2, published_at=now()
        WHERE id=$1`,
      [v1, actorId],
    );
    const first = await pool.query(
      `SELECT v.ruleset_sha256, v.published_at, c.schema_version
         FROM catalogue.category_schema_versions v
         JOIN catalogue.categories c ON c.id=v.category_id
        WHERE v.id=$1`,
      [v1],
    );
    assert.match(first.rows[0].ruleset_sha256.trim(), /^[0-9a-f]{64}$/);
    assert.notEqual(first.rows[0].ruleset_sha256.trim(), 'a'.repeat(64), 'publication must replace caller-supplied hash');
    assert.ok(first.rows[0].published_at);
    assert.equal(first.rows[0].schema_version, 1);

    const v2 = await insertVersion(pool, category.id, 2, null, { required: true });
    await pool.query(
      `UPDATE catalogue.category_schema_versions
          SET state='PUBLISHED', approved_by=$2, published_at=now()
        WHERE id=$1`,
      [v2, actorId],
    );
    const versions = await pool.query(
      `SELECT version, ruleset_sha256, state FROM catalogue.category_schema_versions
        WHERE category_id=$1 ORDER BY version`,
      [category.id],
    );
    assert.equal(versions.rows.length, 2);
    assert.equal(versions.rows[0].state, 'PUBLISHED');
    assert.equal(versions.rows[1].state, 'PUBLISHED');
    assert.notEqual(versions.rows[0].ruleset_sha256.trim(), versions.rows[1].ruleset_sha256.trim(),
      'typed attribute rule changes must change the published content hash');

    await assert.rejects(
      pool.query(`UPDATE catalogue.category_schema_versions SET ruleset='{"tampered":true}' WHERE id=$1`, [v1]),
      (error) => error.code === '23514',
      'a published schema snapshot cannot be edited',
    );
    await assert.rejects(
      pool.query('DELETE FROM catalogue.category_schema_versions WHERE id=$1', [v1]),
      (error) => error.code === '23514',
      'a published schema snapshot cannot be deleted',
    );
    const pointer = await pool.query('SELECT schema_version FROM catalogue.categories WHERE id=$1', [category.id]);
    assert.equal(pointer.rows[0].schema_version, 2);
  });

  await t.test('product revisions cannot pin a different category schema than their parent product', async () => {
    const actorId = await insertActor(pool, randomUUID());
    const category = await insertCategory(pool, randomUUID());
    await insertVersion(pool, category.id, 1, actorId, { publish: true, required: false });
    await insertVersion(pool, category.id, 2, actorId, { publish: true, required: true });
    const brand = await pool.query(
      `INSERT INTO brands.brands (slug, legal_name, display_name, onboarding_state)
       VALUES ($1, 'REN2-56 Synthetic Ltd', 'REN2-56 Synthetic', 'approved') RETURNING id`,
      [`ren2-56-${randomUUID()}`],
    );
    const product = await pool.query(
      `INSERT INTO catalogue.products (brand_id, category_id, style_code, title, category_schema_version)
       VALUES ($1, $2, $3, 'REN2-56 Product', 1) RETURNING id`,
      [brand.rows[0].id, category.id, `R56-${randomUUID()}`],
    );
    const insertRevision = (schemaVersion) => pool.query(
      `INSERT INTO catalogue.product_revisions
         (brand_id, product_id, content_version, content_snapshot, content_sha256, submitted_by, category_id, category_schema_version)
       VALUES ($1, $2, $3, '{}'::jsonb, repeat('b', 64), $4, $5, $6)`,
      [brand.rows[0].id, product.rows[0].id, schemaVersion, actorId, category.id, schemaVersion],
    );
    await insertRevision(1);
    await assert.rejects(
      insertRevision(2),
      (error) => error.code === '23503',
      'a revision must keep the exact category schema version pinned by its product',
    );
  });

  await t.test('activation and retirement require actor context and append immutable audit events', async () => {
    const actorId = await insertActor(pool, randomUUID());
    const category = await insertCategory(pool, randomUUID());
    await insertVersion(pool, category.id, 1, actorId, { publish: true });
    await assert.rejects(
      pool.query('UPDATE catalogue.categories SET active=true WHERE id=$1', [category.id]),
      (error) => error.code === '42501',
      'category activation must not occur without trusted audit context',
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.taxonomy_actor_user_id',$1,true)", [actorId]);
      await client.query("SELECT set_config('app.taxonomy_request_id',$1,true)", [`ren2-56:${randomUUID()}`]);
      await client.query("SELECT set_config('app.taxonomy_reason_code','PILOT_APPROVED',true)");
      await client.query('UPDATE catalogue.categories SET active=true WHERE id=$1', [category.id]);
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query("SELECT set_config('app.taxonomy_actor_user_id',$1,true)", [actorId]);
      await client.query("SELECT set_config('app.taxonomy_request_id',$1,true)", [`ren2-56:${randomUUID()}`]);
      await client.query("SELECT set_config('app.taxonomy_reason_code','POLICY_RETIRED',true)");
      await client.query('UPDATE catalogue.categories SET active=false WHERE id=$1', [category.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const events = await pool.query(
      `SELECT active_before, active_after, actor_user_id, reason_code
         FROM catalogue.category_availability_events WHERE category_id=$1 ORDER BY occurred_at, id`,
      [category.id],
    );
    assert.deepEqual(events.rows.map(({ active_before, active_after, reason_code }) => [active_before, active_after, reason_code]), [
      [false, true, 'PILOT_APPROVED'],
      [true, false, 'POLICY_RETIRED'],
    ]);
    assert.ok(events.rows.every((event) => event.actor_user_id === actorId));
    await assert.rejects(
      pool.query('DELETE FROM catalogue.category_availability_events WHERE category_id=$1', [category.id]),
      (error) => error.code === '23514',
      'availability audit events must be append-only',
    );
  });

  await t.test('parallel publications cannot move the category pointer backward', async () => {
    const actorId = await insertActor(pool, randomUUID());
    const category = await insertCategory(pool, randomUUID());
    const v1 = await insertVersion(pool, category.id, 1, null, null);
    const v2 = await insertVersion(pool, category.id, 2, null, null);
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await first.query(
        `UPDATE catalogue.category_schema_versions SET state='PUBLISHED', approved_by=$2, published_at=now() WHERE id=$1`,
        [v1, actorId],
      );
      const secondPublication = second.query(
        `UPDATE catalogue.category_schema_versions SET state='PUBLISHED', approved_by=$2, published_at=now() WHERE id=$1`,
        [v2, actorId],
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      await first.query('COMMIT');
      await secondPublication;
      await second.query('COMMIT');
    } catch (error) {
      await first.query('ROLLBACK');
      await second.query('ROLLBACK');
      throw error;
    } finally {
      first.release();
      second.release();
    }
    const result = await pool.query(
      `SELECT c.schema_version, count(*) FILTER (WHERE v.state='PUBLISHED')::integer AS published_count
         FROM catalogue.categories c
         JOIN catalogue.category_schema_versions v ON v.category_id=c.id
        WHERE c.id=$1 GROUP BY c.schema_version`,
      [category.id],
    );
    assert.equal(result.rows[0].schema_version, 2);
    assert.equal(result.rows[0].published_count, 2);
  });
});
