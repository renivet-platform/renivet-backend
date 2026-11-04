'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { PricePostgresRepository } = require('../../dist/modules/catalog/price.repository.js');
const { PriceService } = require('../../dist/modules/catalog/price.service.js');
const { ProductDraftPostgresRepository } = require('../../dist/modules/catalog/product-draft.repository.js');
const { TaxonomyAdminPostgresRepository } = require('../../dist/modules/catalog/taxonomy-admin.repository.js');
const { normalizeProductCreate } = require('../../dist/modules/catalog/product-draft.service.js');

const url = process.env.RENIVET_TEST_DATABASE_URL;
function expectCode(code) { return (error) => error?.code === code; }
function assertDisposable(value) {
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required for REN2-64 integration tests');
  const parsed = new URL(value);
  assert.equal(parsed.protocol, 'postgresql:');
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, '/renivet_ci');
  assert.equal(parsed.username, 'renivet_ci');
}

function adminConnectionString(value) {
  const parsed = new URL(value);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

test('REN2-64 persists INR proposals, scopes price history, enforces CAS and approved-window exclusion on PostgreSQL 16', {
  skip: !url && 'requires the disposable PostgreSQL 16 database', timeout: 90_000,
}, async (t) => {
  assertDisposable(url);
  const databaseName = `ren2_64_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = adminConnectionString(url);
  const adminPool = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5_000 });
  const sourcePool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
  const sourceVersion = await sourcePool.query('SHOW server_version_num');
  assert.ok(Number(sourceVersion.rows[0].server_version_num) >= 160000 && Number(sourceVersion.rows[0].server_version_num) < 170000);
  await sourcePool.end();
  try {
    const role = await adminPool.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
    assert.equal(role.rows[0]?.rolsuper, true, 'isolated integration clone requires the disposable PostgreSQL superuser');
    await adminPool.query(`CREATE DATABASE ${databaseName} TEMPLATE renivet_ci`);
  } finally { await adminPool.end(); }
  const isolatedUrl = new URL(url);
  isolatedUrl.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: isolatedUrl.toString(), max: 8, connectionTimeoutMillis: 5_000 });
  t.after(async () => {
    await pool.end();
    const cleanup = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5_000 });
    try { await cleanup.query(`DROP DATABASE ${databaseName} WITH (FORCE)`); }
    finally { await cleanup.end(); }
  });
  const version = await pool.query('SHOW server_version_num');
  assert.ok(Number(version.rows[0].server_version_num) >= 160000 && Number(version.rows[0].server_version_num) < 170000);

  const suffix = randomUUID().replaceAll('-', '');
  const user = async (name) => (await pool.query(
    `INSERT INTO identity.users(email,display_name,state) VALUES($1,$2,'active') RETURNING id`,
    [`ren2-64-${name}-${suffix}@example.invalid`, name])).rows[0].id;
  const actor = await user('maker');
  const grantor = await user('grantor');
  const reviewer = await user('reviewer');
  const brand = (await pool.query(
    `INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
     VALUES($1,'REN2-64 Synthetic','REN2-64 Synthetic','approved') RETURNING id`, [`ren2-64-${suffix}`])).rows[0].id;
  await pool.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at)
    VALUES($1,$2,'active',$3,now())`, [brand, actor, grantor]);
  const role = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
    VALUES($1,'brand','REN2-64 disposable role',false) RETURNING id`, [`ren2_64_${suffix}`])).rows[0].id;
  for (const [permissionCode, resource, action] of [['catalog.write', 'catalog', 'write'], ['pricing.write', 'pricing', 'write'], ['pricing.read', 'pricing', 'read']]) {
    const permission = (await pool.query(
      `INSERT INTO access.permissions(permission_code,resource,action,description) VALUES($1,$2,$3,'REN2-64 integration')
       ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code RETURNING id`,
      [permissionCode, resource, action])).rows[0].id;
    await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [role, permission]);
  }
  await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
    VALUES($1,$2,$3,'brand',now(),$4)`, [actor, role, brand, grantor]);

  const categoryCode = `ren2-64-${suffix}`;
  const categoryId = (await pool.query(`INSERT INTO catalogue.categories(code,name) VALUES($1,$1) RETURNING id`, [categoryCode])).rows[0].id;
  const attribute = await pool.query(
    `INSERT INTO catalogue.attributes(code,label,value_type,scope_type,allowed_values)
     VALUES($1,'REN2-64 fixture','enum','product','["standard"]'::jsonb) RETURNING id,code`, [`ren2-64-material-${suffix}`]);
  const admin = new TaxonomyAdminPostgresRepository({ pool });
  const proposal = { categoryId, version: 1, validatorVersion: 'w2-attribute-validator-v1', ruleset: { attributes: [
    { attributeId: attribute.rows[0].id, code: attribute.rows[0].code, scope: 'product', valueType: 'enum', allowedValues: ['standard'], requiredByDefault: false },
  ] } };
  await admin.propose(proposal, { actorId: actor, requestId: `taxonomy-propose-${suffix}`, idempotencyKey: `taxonomy-propose-${suffix}` });
  await admin.publish({ categoryId, version: 1 }, { actorId: reviewer, requestId: `taxonomy-publish-${suffix}`, idempotencyKey: `taxonomy-publish-${suffix}` });
  const activation = await pool.connect();
  try {
    await activation.query('BEGIN');
    await activation.query(`SELECT set_config('app.taxonomy_actor_user_id',$1,true),
      set_config('app.taxonomy_request_id',$2,true),set_config('app.taxonomy_reason_code','INITIAL_ACTIVATION',true)`, [reviewer, `activate-${suffix}`]);
    await activation.query('UPDATE catalogue.categories SET active=true WHERE id=$1', [categoryId]);
    await activation.query('COMMIT');
  } catch (error) { await activation.query('ROLLBACK'); throw error; } finally { activation.release(); }

  const products = new ProductDraftPostgresRepository({ pool });
  const draft = await products.create(normalizeProductCreate({ styleCode: `style-${suffix.slice(0, 18)}`,
    categoryCode, categorySchemaVersion: 1, title: 'REN2-64 price fixture', variants: [{ sku: `sku-${suffix.slice(0, 18)}`, options: {} }] }),
  { userId: actor, brandId: brand, permission: 'catalog.write', requestId: `product-${suffix}`, idempotencyKey: `product-${suffix}` });
  const variantId = draft.variantIds[0];
  const repository = new PricePostgresRepository({ pool });
  const prices = new PriceService(repository);
  const from = '2026-11-04T12:00:00Z';
  const to = '2026-11-04T13:00:00Z';
  const priceInput = { currency: 'INR', sellingPriceMinor: 12_505, mrpMinor: 15_000, validFrom: from, validTo: to, ruleVersion: 1 };
  const context = (key) => ({ userId: actor, brandId: brand, permission: 'pricing.write', requestId: `request-${key}`, idempotencyKey: key });

  const first = await prices.propose(variantId, priceInput, '"1"', context(`proposal-one-${suffix}`));
  assert.equal(first.status, 'PENDING');
  assert.equal(first.rowVersion, 2);
  const storedReceipt = await pool.query(`SELECT id FROM catalogue.price_mutation_receipts
    WHERE brand_id=$1 AND actor_user_id=$2 AND idempotency_key=$3`, [brand, actor, `proposal-one-${suffix}`]);
  await assert.rejects(pool.query('UPDATE catalogue.price_mutation_receipts SET response_payload=response_payload WHERE id=$1', [storedReceipt.rows[0].id]),
    (error) => error.code === '23514' && error.message.includes('PRICE_RECEIPT_IMMUTABLE'));
  const replay = await prices.propose(variantId, priceInput, '"1"', context(`proposal-one-${suffix}`));
  assert.deepEqual(replay, first, 'exact retries return the original receipt before stale CAS is evaluated');
  await assert.rejects(prices.propose(variantId, { ...priceInput, sellingPriceMinor: 12_504 }, '"1"', context(`proposal-one-${suffix}`)), expectCode('PRICE_IDEMPOTENCY_CONFLICT'));

  const second = await prices.propose(variantId, priceInput, '"2"', context(`proposal-two-${suffix}`));
  assert.equal(second.status, 'PENDING', 'overlapping pending proposals are allowed');
  assert.equal(second.rowVersion, 3);
  await assert.rejects(prices.propose(variantId, priceInput, '"1"', context(`stale-${suffix}`)), expectCode('PRICE_VERSION_CONFLICT'));
  const history = await prices.list(variantId, { userId: actor, brandId: brand, permission: 'pricing.read' });
  assert.equal(history.items.length, 2);
  assert.equal(history.items[0].currency, 'INR');
  assert.equal(history.items[0].amountMinor, 12_505);

  const decide = async (priceId) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const changed = await client.query(
        `UPDATE catalogue.variant_prices SET price_state='APPROVED', row_version=row_version+1,
           decided_by=$2, decision_reason_code='TEST_APPROVAL', decided_at=now(), updated_at=now()
         WHERE id=$1 AND price_state='PENDING' RETURNING *`, [priceId, reviewer]);
      await client.query(
        `INSERT INTO catalogue.price_audit_events(brand_id,variant_id,price_id,action,prior_snapshot,next_snapshot,actor_user_id,business_effect_key)
         VALUES($1,$2,$3,'APPROVED','{}'::jsonb,$4::jsonb,$5,$6)`,
        [brand, variantId, priceId, JSON.stringify({ id: priceId, priceState: 'APPROVED' }), reviewer, `approve-${priceId}`]);
      await client.query('COMMIT');
      return changed.rowCount;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  const approvals = await Promise.allSettled([decide(first.id), decide(second.id)]);
  assert.equal(approvals.filter((item) => item.status === 'fulfilled' && item.value === 1).length, 1);
  assert.equal(approvals.filter((item) => item.status === 'rejected' && item.reason.code === '23P01').length, 1,
    'the PostgreSQL exclusion constraint serializes overlapping approvals');

  const approved = await pool.query(`SELECT id FROM catalogue.variant_prices WHERE brand_id=$1 AND variant_id=$2 AND price_state='APPROVED'`, [brand, variantId]);
  assert.equal(approved.rowCount, 1);
  await assert.rejects(pool.query('UPDATE catalogue.variant_prices SET amount_minor=1 WHERE id=$1', [approved.rows[0].id]),
    (error) => error.code === '23514' && error.message.includes('PRICE_VERSION_IMMUTABLE'));
  const audit = await pool.query('SELECT id FROM catalogue.price_audit_events WHERE price_id=$1 AND action=\'APPROVED\'', [approved.rows[0].id]);
  assert.equal(audit.rowCount, 1);
  await assert.rejects(pool.query('DELETE FROM catalogue.price_audit_events WHERE id=$1', [audit.rows[0].id]),
    (error) => error.code === '23514' && error.message.includes('PRICE_AUDIT_IMMUTABLE'));

  const adjacent = await prices.propose(variantId, { ...priceInput, validFrom: to, validTo: '2026-11-04T14:00:00Z' }, '"3"', context(`adjacent-${suffix}`));
  assert.equal(adjacent.status, 'PENDING');
  await decide(adjacent.id);
  const approvedCount = await pool.query(`SELECT count(*)::integer AS count FROM catalogue.variant_prices
    WHERE brand_id=$1 AND variant_id=$2 AND price_state='APPROVED'`, [brand, variantId]);
  assert.equal(approvedCount.rows[0].count, 2, 'an end at 13:00 and start at 13:00 are adjacent under [from,to)');

  const otherBrand = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
    VALUES($1,'REN2-64 Other','REN2-64 Other','approved') RETURNING id`, [`ren2-64-other-${suffix}`])).rows[0].id;
  await assert.rejects(prices.list(variantId, { userId: actor, brandId: otherBrand, permission: 'pricing.read' }), expectCode('PRICE_VARIANT_NOT_FOUND'));
});
