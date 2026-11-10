'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { InventoryPostgresRepository } = require('../../dist/modules/inventory/inventory.repository.js');

const sourceUrl = process.env.RENIVET_TEST_DATABASE_URL;
function disposableUrl(value) {
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required for REN2-90 PostgreSQL acceptance');
  const url = new URL(value);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/renivet_ci');
  assert.equal(url.username, 'renivet_ci');
  return url;
}
function workerAuthorization(brandId, sourceEventId) {
  return {
    principalId: 'renivet.synthetic.w3', jobId: randomUUID(), sourceEventId, brandId,
    purpose: 'inventory.allocate', effects: ['inventory.allocate'], provenance: 'synthetic.accepted-checkout',
    async authorizeEffect(effect, targetBrandId) {
      if (effect !== 'inventory.allocate' || targetBrandId !== brandId) {
        throw Object.assign(new Error('worker authorization denied'), { code: 'WORKER_AUTHORIZATION_DENIED' });
      }
    },
  };
}

test('REN2-90 serializes accepted checkout allocations and journals each winning unit exactly once', {
  timeout: 120_000,
  skip: !sourceUrl && 'requires a fresh disposable PostgreSQL 16 service',
}, async (t) => {
  const baseUrl = disposableUrl(sourceUrl);
  const database = `allocation_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: baseUrl.toString(), max: 1 });
  let pool;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE renivet_ci`);
    created = true;
    const databaseUrl = new URL(baseUrl);
    databaseUrl.pathname = `/${database}`;
    pool = new Pool({ connectionString: databaseUrl.toString(), max: 100, connectionTimeoutMillis: 15_000 });
    const version = await pool.query('SHOW server_version_num');
    assert.ok(Number(version.rows[0].server_version_num) >= 160000 && Number(version.rows[0].server_version_num) < 170000);

    const suffix = randomUUID().replaceAll('-', '');
    const ownerId = (await pool.query(`INSERT INTO identity.users(email,state) VALUES($1,'active') RETURNING id`, [`allocator-${suffix}@example.invalid`])).rows[0].id;
    const grantorId = (await pool.query(`INSERT INTO identity.users(email,state) VALUES($1,'active') RETURNING id`, [`allocator-grantor-${suffix}@example.invalid`])).rows[0].id;
    const brandId = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
      VALUES($1,'Allocator test','Allocator test','approved') RETURNING id`, [`allocator-${suffix}`])).rows[0].id;
    const foreignBrandId = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
      VALUES($1,'Foreign test','Foreign test','approved') RETURNING id`, [`allocator-foreign-${suffix}`])).rows[0].id;
    await pool.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at)
      VALUES($1,$2,'active',$3,now())`, [brandId, ownerId, grantorId]);
    const roleId = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
      VALUES($1,'brand','REN2-90 disposable role',false) RETURNING id`, [`allocator_${suffix}`])).rows[0].id;
    const permissionId = (await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description)
      VALUES('inventory.submit','inventory','submit','REN2-90 stock allocation fixture permission')
      ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code RETURNING id`)).rows[0].id;
    await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [roleId, permissionId]);
    await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
      VALUES($1,$2,$3,'brand',now(),$4)`, [ownerId, roleId, brandId, grantorId]);

    const categoryId = (await pool.query(`INSERT INTO catalogue.categories(code,name) VALUES($1,'Allocator test') RETURNING id`, [`alloc-${suffix}`])).rows[0].id;
    await pool.query(`INSERT INTO catalogue.category_schema_versions(category_id,version,ruleset_sha256,validator_version)
      VALUES($1,1,repeat('a',64),'ren2-90-fixture')`, [categoryId]);
    const productId = (await pool.query(`INSERT INTO catalogue.products(brand_id,category_id,style_code,title,category_schema_version)
      VALUES($1,$2,$3,'Allocator product',1) RETURNING id`, [brandId, categoryId, `ALLOC-${suffix}`])).rows[0].id;
    const variantId = (await pool.query(`INSERT INTO catalogue.product_variants(brand_id,product_id,sku,option_signature,options)
      VALUES($1,$2,$3,'default','{}'::jsonb) RETURNING id`, [brandId, productId, `ALLOC-${suffix}`])).rows[0].id;
    const foreignCategoryId = (await pool.query(`INSERT INTO catalogue.categories(code,name) VALUES($1,'Foreign test') RETURNING id`, [`alloc-foreign-${suffix}`])).rows[0].id;
    await pool.query(`INSERT INTO catalogue.category_schema_versions(category_id,version,ruleset_sha256,validator_version)
      VALUES($1,1,repeat('b',64),'ren2-90-fixture')`, [foreignCategoryId]);
    const foreignProductId = (await pool.query(`INSERT INTO catalogue.products(brand_id,category_id,style_code,title,category_schema_version)
      VALUES($1,$2,$3,'Foreign product',1) RETURNING id`, [foreignBrandId, foreignCategoryId, `FOREIGN-${suffix}`])).rows[0].id;
    const foreignVariantId = (await pool.query(`INSERT INTO catalogue.product_variants(brand_id,product_id,sku,option_signature,options)
      VALUES($1,$2,$3,'default','{}'::jsonb) RETURNING id`, [foreignBrandId, foreignProductId, `FOREIGN-${suffix}`])).rows[0].id;
    const locationId = (await pool.query(`INSERT INTO inventory.stock_locations(brand_id,location_code,name)
      VALUES($1,$2,'Allocator test') RETURNING id`, [brandId, `A-${suffix}`])).rows[0].id;
    const foreignLocationId = (await pool.query(`INSERT INTO inventory.stock_locations(brand_id,location_code,name)
      VALUES($1,$2,'Foreign allocator test') RETURNING id`, [foreignBrandId, `F-${suffix}`])).rows[0].id;
    const acceptedEvent = async (checkoutId, key, eventType = 'checkout.accepted') => (await pool.query(`INSERT INTO platform.outbox_events
      (aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
      VALUES('checkout.order',$1,$3,1,$2::jsonb,$4) RETURNING id`,
    [checkoutId, JSON.stringify({ brandId }), eventType, key])).rows[0].id;

    const repository = new InventoryPostgresRepository({ pool });
    const userContext = { userId: ownerId, brandId, permission: 'inventory.submit' };
    await repository.openingReceipt(userContext, { variantId, locationId, quantity: 3, unit: 'EACH',
      sourceType: 'SYNTHETIC', sourceReference: `three-units-${suffix}` }, `opening-${suffix}`);

    const foreignAuthCheckout = randomUUID();
    const foreignAuthEvent = await acceptedEvent(foreignAuthCheckout, `ren2-90-auth-denial-${suffix}`);
    await assert.rejects(repository.allocateTrusted(workerAuthorization(foreignBrandId, foreignAuthEvent), {
      brandId, checkoutId: foreignAuthCheckout, checkoutLineId: randomUUID(), acceptedSequence: 1, variantId, locationId,
      quantity: 1, idempotencyKey: `foreign-${suffix}`,
    }), (error) => error?.response?.code === 'WORKER_AUTHORIZATION_DENIED' || error?.code === 'WORKER_AUTHORIZATION_DENIED',
    'a different brand principal cannot allocate this stock');
    const foreignSkuCheckout = randomUUID();
    const foreignSkuEvent = await acceptedEvent(foreignSkuCheckout, `ren2-90-foreign-sku-${suffix}`);
    await assert.rejects(repository.allocateTrusted(workerAuthorization(brandId, foreignSkuEvent), {
      brandId, checkoutId: foreignSkuCheckout, checkoutLineId: randomUUID(), acceptedSequence: 1, variantId: foreignVariantId, locationId,
      quantity: 1, idempotencyKey: `foreign-variant-${suffix}`,
    }), (error) => error?.response?.code === 'STOCK_TARGET_NOT_FOUND', 'a guessed foreign SKU is non-disclosing');
    const foreignLocationCheckout = randomUUID();
    const foreignLocationEvent = await acceptedEvent(foreignLocationCheckout, `ren2-90-foreign-location-${suffix}`);
    await assert.rejects(repository.allocateTrusted(workerAuthorization(brandId, foreignLocationEvent), {
      brandId, checkoutId: foreignLocationCheckout, checkoutLineId: randomUUID(), acceptedSequence: 1, variantId, locationId: foreignLocationId,
      quantity: 1, idempotencyKey: `foreign-location-${suffix}`,
    }), (error) => error?.response?.code === 'STOCK_TARGET_NOT_FOUND', 'a guessed foreign warehouse is non-disclosing');
    await assert.rejects(pool.query(`INSERT INTO inventory.stock_allocations(brand_id,variant_id,location_id,checkout_id,
      checkout_line_id,accepted_sequence,quantity,allocation_state)
      VALUES($1,$2,$3,$4,$5,1,1,'ALLOCATED')`,
    [brandId, variantId, foreignLocationId, randomUUID(), randomUUID()]),
    (error) => error?.code === '23503', 'the database composite pool foreign key rejects a cross-brand location');
    const unverifiedCheckout = randomUUID();
    const unverifiedEvent = await acceptedEvent(unverifiedCheckout, `ren2-90-unverified-${suffix}`, 'checkout.payment_pending');
    await assert.rejects(repository.allocateTrusted(workerAuthorization(brandId, unverifiedEvent), {
      brandId, checkoutId: unverifiedCheckout, checkoutLineId: randomUUID(), acceptedSequence: 1,
      variantId, locationId, quantity: 1, idempotencyKey: `unverified-${suffix}`,
    }), (error) => error?.response?.code === 'WORKER_SOURCE_NOT_VERIFIED',
    'unverified and COD-like checkout events cannot consume authoritative stock');

    const requests = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      const checkoutId = randomUUID();
      const sourceEventId = await acceptedEvent(checkoutId, `ren2-90-race-${suffix}-${index}`);
      return { command: { brandId, checkoutId, checkoutLineId: randomUUID(), acceptedSequence: index + 1,
        variantId, locationId, quantity: 1, idempotencyKey: `race-${suffix}-${index}` }, authorization: workerAuthorization(brandId, sourceEventId) };
    }));
    const results = await Promise.all(requests.map(({ command, authorization }) => repository.allocateTrusted(authorization, command)));
    const winners = results.filter((result) => result.state === 'ALLOCATED');
    const rejected = results.filter((result) => result.state === 'PAID_STOCK_UNAVAILABLE');
    assert.equal(winners.length, 3, '100 competing completions against three units produce exactly three allocations');
    assert.equal(rejected.length, 97);
    assert.equal(new Set(winners.map((result) => result.allocationId)).size, 3);

    const winningIndex = results.findIndex((result) => result.state === 'ALLOCATED');
    const replay = await repository.allocateTrusted(requests[winningIndex].authorization, requests[winningIndex].command);
    assert.equal(replay.state, 'ALLOCATED');
    assert.equal(replay.allocationId, winners[0].allocationId);
    assert.equal(replay.replayed, true, 'the same accepted command returns its recorded allocation');
    await assert.rejects(repository.allocateTrusted(requests[winningIndex].authorization, {
      ...requests[winningIndex].command, quantity: 2,
    }), (error) => error?.response?.code === 'IDEMPOTENCY_KEY_REUSED', 'reusing a command key with changed quantity is rejected');
    const naturalDuplicate = await repository.allocateTrusted(requests[winningIndex].authorization, {
      ...requests[winningIndex].command, idempotencyKey: `duplicate-${suffix}`,
    });
    assert.equal(naturalDuplicate.allocationId, winners[0].allocationId);
    assert.equal(naturalDuplicate.replayed, true, 'a second delivery key for the accepted line cannot allocate twice');

    const balance = (await pool.query(`SELECT physical_on_hand,allocated_not_dispatched,safety_buffer,quarantined,other_non_sellable
      FROM inventory.stock_balances WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3`, [brandId, variantId, locationId])).rows[0];
    assert.equal(Number(balance.physical_on_hand), 3);
    assert.equal(Number(balance.allocated_not_dispatched), 3, 'A is deducted exactly once');
    assert.equal(Math.max(0, Number(balance.physical_on_hand) - Number(balance.quarantined) - Number(balance.other_non_sellable)
      - Number(balance.allocated_not_dispatched) - Number(balance.safety_buffer)), 0);
    const journal = await pool.query(`SELECT count(*)::integer AS events, count(DISTINCT allocation_id)::integer AS allocations
      FROM inventory.stock_commitment_events WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3`, [brandId, variantId, locationId]);
    assert.deepEqual(journal.rows[0], { events: 3, allocations: 3 });
    const records = await pool.query(`SELECT accepted_sequence::integer FROM inventory.stock_allocations
      WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 ORDER BY accepted_sequence`, [brandId, variantId, locationId]);
    assert.deepEqual(records.rows.map((row) => row.accepted_sequence).sort((a, b) => a - b),
      winners.map((result) => result.acceptedSequence).sort((a, b) => a - b), 'the durable allocation keeps the supplied accepted order');
    const events = await pool.query(`SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE event_payload->>'eventKind'='COMMITMENT' AND event_version=1)::integer AS allocation_events
      FROM platform.outbox_events WHERE aggregate_id=$1 AND event_type='inventory.stock.changed'`, [variantId]);
    assert.deepEqual(events.rows[0], { total: 5, allocation_events: 3 },
      'genesis, opening receipt and three version-1 allocation events are emitted');
  } finally {
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  }
});
