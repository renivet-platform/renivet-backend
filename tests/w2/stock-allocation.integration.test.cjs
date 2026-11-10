'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { InventoryPostgresRepository } = require('../../dist/modules/inventory/inventory.repository.js');

const sourceUrl = process.env.RENIVET_TEST_DATABASE_URL;
function disposableUrl(value) {
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required for REN2-90/93 PostgreSQL acceptance');
  const url = new URL(value);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/renivet_ci');
  assert.equal(url.username, 'renivet_ci');
  return url;
}
function workerAuthorization(brandId, sourceEventId, purpose = 'inventory.allocate', effect = 'inventory.allocate', principalId = 'renivet.synthetic.w3') {
  return {
    principalId, jobId: randomUUID(), sourceEventId, brandId,
    purpose, effects: [effect], provenance: 'synthetic.accepted-checkout',
    async authorizeEffect(effect, targetBrandId) {
      if (effect !== this.effects[0] || targetBrandId !== brandId) {
        throw Object.assign(new Error('worker authorization denied'), { code: 'WORKER_AUTHORIZATION_DENIED' });
      }
    },
  };
}

test('REN2-90/93 serializes checkout allocation and lifecycle effects exactly once', {
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
    const acceptedEvent = async (checkoutId, key, acceptedSequence = 1, lines = [], eventType = 'checkout.accepted') => (await pool.query(`INSERT INTO platform.outbox_events
      (aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
      VALUES('checkout.order',$1,$3,1,$2::jsonb,$4) RETURNING id`,
    [checkoutId, JSON.stringify({ brandId, acceptedSequence, lines }), eventType, key])).rows[0].id;

    const repository = new InventoryPostgresRepository({ pool });
    const userContext = { userId: ownerId, brandId, permission: 'inventory.submit' };
    await repository.openingReceipt(userContext, { variantId, locationId, quantity: 3, unit: 'EACH',
      sourceType: 'SYNTHETIC', sourceReference: `three-units-${suffix}` }, `opening-${suffix}`);

    const foreignAuthCheckout = randomUUID();
    const foreignAuthLine = randomUUID();
    const foreignAuthEvent = await acceptedEvent(foreignAuthCheckout, `ren2-90-auth-denial-${suffix}`, 1,
      [{ checkoutLineId: foreignAuthLine, variantId, locationId, quantity: 1 }]);
    await assert.rejects(repository.allocateTrusted(workerAuthorization(foreignBrandId, foreignAuthEvent), {
      brandId, checkoutId: foreignAuthCheckout, checkoutLineId: foreignAuthLine, acceptedSequence: 1, variantId, locationId,
      quantity: 1, idempotencyKey: `foreign-${suffix}`,
    }), (error) => error?.response?.code === 'WORKER_AUTHORIZATION_DENIED' || error?.code === 'WORKER_AUTHORIZATION_DENIED',
    'a different brand principal cannot allocate this stock');
    const foreignSkuCheckout = randomUUID();
    const foreignSkuLine = randomUUID();
    const foreignSkuEvent = await acceptedEvent(foreignSkuCheckout, `ren2-90-foreign-sku-${suffix}`, 1,
      [{ checkoutLineId: foreignSkuLine, variantId: foreignVariantId, locationId, quantity: 1 }]);
    await assert.rejects(repository.allocateTrusted(workerAuthorization(brandId, foreignSkuEvent), {
      brandId, checkoutId: foreignSkuCheckout, checkoutLineId: foreignSkuLine, acceptedSequence: 1, variantId: foreignVariantId, locationId,
      quantity: 1, idempotencyKey: `foreign-variant-${suffix}`,
    }), (error) => error?.response?.code === 'STOCK_TARGET_NOT_FOUND', 'a guessed foreign SKU is non-disclosing');
    const foreignLocationCheckout = randomUUID();
    const foreignLocationLine = randomUUID();
    const foreignLocationEvent = await acceptedEvent(foreignLocationCheckout, `ren2-90-foreign-location-${suffix}`, 1,
      [{ checkoutLineId: foreignLocationLine, variantId, locationId: foreignLocationId, quantity: 1 }]);
    await assert.rejects(repository.allocateTrusted(workerAuthorization(brandId, foreignLocationEvent), {
      brandId, checkoutId: foreignLocationCheckout, checkoutLineId: foreignLocationLine, acceptedSequence: 1, variantId, locationId: foreignLocationId,
      quantity: 1, idempotencyKey: `foreign-location-${suffix}`,
    }), (error) => error?.response?.code === 'STOCK_TARGET_NOT_FOUND', 'a guessed foreign warehouse is non-disclosing');
    await assert.rejects(pool.query(`INSERT INTO inventory.stock_allocations(brand_id,variant_id,location_id,checkout_id,
      checkout_line_id,accepted_sequence,quantity,allocation_state)
      VALUES($1,$2,$3,$4,$5,1,1,'ALLOCATED')`,
    [brandId, variantId, foreignLocationId, randomUUID(), randomUUID()]),
    (error) => error?.code === '23503', 'the database composite pool foreign key rejects a cross-brand location');
    const unverifiedCheckout = randomUUID();
    const unverifiedLine = randomUUID();
    const unverifiedEvent = await acceptedEvent(unverifiedCheckout, `ren2-90-unverified-${suffix}`, 1,
      [{ checkoutLineId: unverifiedLine, variantId, locationId, quantity: 1 }], 'checkout.payment_pending');
    await assert.rejects(repository.allocateTrusted(workerAuthorization(brandId, unverifiedEvent), {
      brandId, checkoutId: unverifiedCheckout, checkoutLineId: unverifiedLine, acceptedSequence: 1,
      variantId, locationId, quantity: 1, idempotencyKey: `unverified-${suffix}`,
    }), (error) => error?.response?.code === 'WORKER_SOURCE_NOT_VERIFIED',
    'unverified and COD-like checkout events cannot consume authoritative stock');
    const multiLineCheckout = randomUUID();
    const firstLine = { checkoutLineId: randomUUID(), variantId, locationId, quantity: 1 };
    const secondLine = { checkoutLineId: randomUUID(), variantId, locationId, quantity: 1 };
    const multiLineEvent = await acceptedEvent(multiLineCheckout, `ren2-90-multiline-${suffix}`, 1, [firstLine, secondLine]);
    await assert.rejects(repository.allocateTrusted(workerAuthorization(brandId, multiLineEvent), {
      brandId, checkoutId: multiLineCheckout, ...firstLine, acceptedSequence: 1, idempotencyKey: `multiline-${suffix}`,
    }), (error) => error?.response?.code === 'CHECKOUT_MULTI_LINE_POLICY_UNRESOLVED',
    'a multi-line accepted order cannot be partially allocated while all-or-none policy is open');

    const requests = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      const checkoutId = randomUUID();
      const command = { brandId, checkoutId, checkoutLineId: randomUUID(), acceptedSequence: index + 1,
        variantId, locationId, quantity: 1, idempotencyKey: `race-${suffix}-${index}` };
      const sourceEventId = await acceptedEvent(checkoutId, `ren2-90-race-${suffix}-${index}`, index + 1,
        [{ checkoutLineId: command.checkoutLineId, variantId, locationId, quantity: command.quantity }]);
      return { command, authorization: workerAuthorization(brandId, sourceEventId, 'inventory.allocate',
        'inventory.allocate', index === 0 ? randomUUID() : 'renivet.synthetic.w3') };
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
    const changedPrincipal = { ...requests[winningIndex].authorization, principalId: 'renivet.synthetic.other-worker' };
    await assert.rejects(repository.allocateTrusted(changedPrincipal, requests[winningIndex].command),
      (error) => error?.response?.code === 'IDEMPOTENCY_KEY_REUSED',
      'reusing a command key under a different authorized principal is rejected');
    const naturalDuplicate = await repository.allocateTrusted(requests[winningIndex].authorization, {
      ...requests[winningIndex].command, idempotencyKey: `duplicate-${suffix}`,
    });
    assert.equal(naturalDuplicate.allocationId, winners[0].allocationId);
    assert.equal(naturalDuplicate.replayed, true, 'a second delivery key for the accepted line cannot allocate twice');
    const unavailable = await pool.query(`SELECT count(*)::integer AS cases FROM inventory.stock_paid_unavailable_cases
      WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3`, [brandId, variantId, locationId]);
    assert.equal(unavailable.rows[0].cases, 97, 'each paid checkout that lost the last-unit race leaves a recovery obligation');
    const recoveryEvents = await pool.query(`SELECT count(*)::integer AS count FROM platform.outbox_events
      WHERE event_type='inventory.paid_stock_unavailable'`);
    assert.equal(recoveryEvents.rows[0].count, 97, 'paid-no-stock is durably published without claiming a refund');
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

    await repository.movement(userContext, { variantId, locationId, effectKey: `restock-${suffix}`,
      reason: 'SYNTHETIC_RESTOCK', sourceType: 'TEST', sourceReference: `restock-${suffix}`, deltaPhysical: 2 });
    const lifecycleCheckout = randomUUID();
    const lifecycleCommand = { brandId, checkoutId: lifecycleCheckout, checkoutLineId: randomUUID(), acceptedSequence: 101,
      variantId, locationId, quantity: 2, idempotencyKey: `lifecycle-allocate-${suffix}` };
    const lifecycleSourceEvent = await acceptedEvent(lifecycleCheckout, `ren2-93-accepted-${suffix}`, 101,
      [{ checkoutLineId: lifecycleCommand.checkoutLineId, variantId, locationId, quantity: lifecycleCommand.quantity }]);
    const lifecycleAllocation = await repository.allocateTrusted(workerAuthorization(brandId, lifecycleSourceEvent), lifecycleCommand);
    assert.equal(lifecycleAllocation.state, 'ALLOCATED');
    const dispatchEventId = (await pool.query(`INSERT INTO platform.outbox_events(aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
      VALUES('checkout.order',$1,'checkout.shipment_confirmed',1,$2::jsonb,$3) RETURNING id`,
    [lifecycleCheckout, JSON.stringify({ brandId }), `ren2-93-dispatch-${suffix}`])).rows[0].id;
    const wrongDispatchSource = await acceptedEvent(lifecycleCheckout, `ren2-93-wrong-dispatch-source-${suffix}`, 101,
      [], 'checkout.accepted');
    const dispatchInput = { brandId, allocationId: lifecycleAllocation.allocationId, quantity: 1,
      expectedBalanceVersion: lifecycleAllocation.balanceVersion, idempotencyKey: `dispatch-${suffix}` };
    await assert.rejects(repository.dispatchTrusted(workerAuthorization(brandId, wrongDispatchSource,
      'inventory.dispatch', 'inventory.dispatch'), { ...dispatchInput, idempotencyKey: `wrong-source-${suffix}` }),
    (error) => error?.response?.code === 'WORKER_SOURCE_NOT_VERIFIED', 'dispatch requires a shipment-confirmed source event');
    const dispatched = await repository.dispatchTrusted(workerAuthorization(brandId, dispatchEventId,
      'inventory.dispatch', 'inventory.dispatch'), dispatchInput);
    assert.equal(dispatched.state, 'PARTIALLY_SHIPPED');
    assert.equal(dispatched.dispatchedQuantity, 1);
    const dispatchReplay = await repository.dispatchTrusted(workerAuthorization(brandId, dispatchEventId,
      'inventory.dispatch', 'inventory.dispatch'), dispatchInput);
    assert.equal(dispatchReplay.replayed, true);
    await assert.rejects(repository.dispatchTrusted(workerAuthorization(brandId, dispatchEventId,
      'inventory.dispatch', 'inventory.dispatch'), { ...dispatchInput, idempotencyKey: `stale-dispatch-${suffix}` }),
    (error) => error?.response?.code === 'STOCK_VERSION_CONFLICT', 'dispatch requires the current pool version');
    const dispatchJournal = await pool.query(`SELECT count(*)::integer AS count,
        bool_and(actor_service_principal='renivet.synthetic.w3' AND source_event_id=$2) AS provenance_recorded
      FROM inventory.stock_events WHERE brand_id=$1 AND business_effect_key LIKE $3`,
    [brandId, dispatchEventId, `dispatch.${lifecycleAllocation.allocationId}.%`]);
    assert.equal(dispatchJournal.rows[0].count, 2, 'dispatch journals A release and physical decrement separately');
    assert.equal(dispatchJournal.rows[0].provenance_recorded, true);

    const cancelEventId = (await pool.query(`INSERT INTO platform.outbox_events(aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
      VALUES('checkout.order',$1,'checkout.cancelled',1,$2::jsonb,$3) RETURNING id`,
    [lifecycleCheckout, JSON.stringify({ brandId }), `ren2-93-cancel-${suffix}`])).rows[0].id;
    const cancelInput = { brandId, allocationId: lifecycleAllocation.allocationId,
      expectedBalanceVersion: dispatched.balanceVersion, idempotencyKey: `cancel-${suffix}` };
    const cancelled = await repository.releaseTrusted(workerAuthorization(brandId, cancelEventId,
      'inventory.release', 'inventory.release'), cancelInput);
    assert.equal(cancelled.state, 'CANCELLED');
    assert.equal(cancelled.releasedQuantity, 1);
    assert.equal(cancelled.dispatchedQuantity, 1);
    const cancelReplay = await repository.releaseTrusted(workerAuthorization(brandId, cancelEventId,
      'inventory.release', 'inventory.release'), cancelInput);
    assert.equal(cancelReplay.replayed, true, 'a duplicate cancellation cannot release A twice');
    await assert.rejects(repository.releaseTrusted(workerAuthorization(brandId, cancelEventId,
      'inventory.release', 'inventory.release'), { ...cancelInput, expectedBalanceVersion: dispatched.balanceVersion + 1 }),
    (error) => error?.response?.code === 'IDEMPOTENCY_KEY_REUSED', 'a changed cancellation retry cannot reuse its receipt key');
    const lifecycleBalance = (await pool.query(`SELECT physical_on_hand,allocated_not_dispatched,row_version FROM inventory.stock_balances
      WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3`, [brandId, variantId, locationId])).rows[0];
    assert.equal(Number(lifecycleBalance.physical_on_hand), 4, 'shipping decreases P only for dispatched units');
    assert.equal(Number(lifecycleBalance.allocated_not_dispatched), 3, 'dispatch releases shipped A and cancellation releases only unshipped A');
    await assert.rejects(pool.query(`UPDATE inventory.stock_allocations SET quantity=quantity+1 WHERE id=$1`,
      [lifecycleAllocation.allocationId]), /STOCK_ALLOCATION_IDENTITY_IMMUTABLE/);
    await assert.rejects(pool.query(`UPDATE inventory.stock_allocations SET allocation_state='DISPATCHED' WHERE id=$1`,
      [lifecycleAllocation.allocationId]), /STOCK_ALLOCATION_LIFECYCLE_STATE_INVALID/);
    const caseId = (await pool.query(`SELECT id FROM inventory.stock_paid_unavailable_cases
      WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 LIMIT 1`, [brandId, variantId, locationId])).rows[0].id;
    await assert.rejects(pool.query(`UPDATE inventory.stock_paid_unavailable_cases SET reason_code='NO_STOCK_POOL' WHERE id=$1`,
      [caseId]), /STOCK_LEDGER_APPEND_ONLY/);

  } finally {
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  }
});
