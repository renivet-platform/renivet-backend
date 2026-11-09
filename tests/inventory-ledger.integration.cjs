'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { InventoryPostgresRepository } = require('../dist/modules/inventory/inventory.repository.js');

function disposableUrl() {
  const value = process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required');
  const url = new URL(value);
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/renivet_ci'); assert.equal(url.username, 'renivet_ci');
  return url;
}

test('REN2-83..89 stock ledger serializes 100 concurrent commands, replays idempotently, and rolls back journal/outbox atomically', {
  timeout: 120_000,
  skip: !process.env.RENIVET_TEST_DATABASE_URL,
}, async () => {
  const sourceUrl = disposableUrl();
  const isolatedName = `inventory_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: sourceUrl.toString(), max: 1 });
  let pool;
  let dbNameCreated = false;
  try {
    await admin.query(`CREATE DATABASE "${isolatedName}" TEMPLATE renivet_ci`);
    dbNameCreated = true;
    const isolatedUrl = new URL(sourceUrl); isolatedUrl.pathname = `/${isolatedName}`;
    // PostgreSQL reserves several connection slots for administration; 90 workers
    // remain below the standard PG16 max_connections=100 while 100 commands race.
    pool = new Pool({ connectionString: isolatedUrl.toString(), max: 100, connectionTimeoutMillis: 10_000 });
    pool.on('error', (error) => process.stderr.write(`Inventory integration pool error: ${error.message}\n`));
    const version = await pool.query('SHOW server_version_num');
    assert.ok(Number(version.rows[0].server_version_num) >= 160000 && Number(version.rows[0].server_version_num) < 170000);

    const setup = await pool.connect();
    let fixture;
    try {
      await setup.query('BEGIN');
      const suffix = randomUUID().replaceAll('-', '');
      const user = await setup.query(`INSERT INTO identity.users(email,state) VALUES($1,'active') RETURNING id`, [`inventory-${suffix}@example.test`]);
      const actorId = user.rows[0].id;
      const reviewer = await setup.query(`INSERT INTO identity.users(email,state) VALUES($1,'active') RETURNING id`, [`inventory-reviewer-${suffix}@example.test`]);
      const reviewerId = reviewer.rows[0].id;
      const brand = await setup.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
        VALUES($1,'Inventory Integration Ltd','Inventory Integration','approved') RETURNING id`, [`inventory-${suffix}`]);
      const brandId = brand.rows[0].id;
      await setup.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at)
        VALUES($1,$2,'active',$2,now())`, [brandId, actorId]);
      await setup.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at)
        VALUES($1,$2,'active',$2,now())`, [brandId, reviewerId]);
      const role = await setup.query(`SELECT id FROM access.roles WHERE role_code='brand_owner'`);
      const adminRole = await setup.query(`SELECT id FROM access.roles WHERE role_code='renivet_admin'`);
      await setup.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
        VALUES($1,$2,$3,'brand',now(),$1)`, [actorId, role.rows[0].id, brandId]);
      await setup.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
        VALUES($1,$2,$3,'brand',now(),$1)`, [reviewerId, role.rows[0].id, brandId]);
      await setup.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
        VALUES($1,$2,NULL,'global',now(),$1)`, [reviewerId, adminRole.rows[0].id]);
      const category = await setup.query(`INSERT INTO catalogue.categories(code,name) VALUES($1,'Inventory Test') RETURNING id`, [`INV-${suffix}`]);
      await setup.query(`INSERT INTO catalogue.category_schema_versions(category_id,version,ruleset_sha256,validator_version)
        VALUES($1,1,repeat('c',64),'inventory-test')`, [category.rows[0].id]);
      const product = await setup.query(`INSERT INTO catalogue.products(brand_id,category_id,style_code,title,category_schema_version)
        VALUES($1,$2,$3,'Inventory test product',1) RETURNING id`, [brandId, category.rows[0].id, `STYLE-${suffix}`]);
      const variant = await setup.query(`INSERT INTO catalogue.product_variants(brand_id,product_id,sku,option_signature,options)
        VALUES($1,$2,$3,'default','{}'::jsonb) RETURNING id`, [brandId, product.rows[0].id, `SKU-${suffix}`]);
      const location = await setup.query(`INSERT INTO inventory.stock_locations(brand_id,location_code,name)
        VALUES($1,'WH-1','Warehouse') RETURNING id`, [brandId]);
      const secondLocation = await setup.query(`INSERT INTO inventory.stock_locations(brand_id,location_code,name)
        VALUES($1,'WH-2','Second Warehouse') RETURNING id`, [brandId]);
      const replayLocation = await setup.query(`INSERT INTO inventory.stock_locations(brand_id,location_code,name)
        VALUES($1,'WH-3','Replay Test Warehouse') RETURNING id`, [brandId]);
      await setup.query('COMMIT');
      fixture = { actorId, reviewerId, brandId, variantId: variant.rows[0].id, locationId: location.rows[0].id,
        secondLocationId: secondLocation.rows[0].id, replayLocationId: replayLocation.rows[0].id };
    } catch (error) { await setup.query('ROLLBACK'); throw error; }
    finally { setup.release(); }

    const repository = new InventoryPostgresRepository({ pool });
    const context = { userId: fixture.actorId, brandId: fixture.brandId, permission: 'inventory.submit' };
    await repository.ensurePool(context, fixture.variantId, fixture.secondLocationId);
    await assert.rejects(pool.query(`UPDATE inventory.stock_balances SET physical_on_hand=10,quarantined=3,
      other_non_sellable=6,allocated_not_dispatched=2 WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3`,
    [fixture.brandId, fixture.variantId, fixture.secondLocationId]), /check constraint/,
    'database must enforce physical stock covers all non-sellable and committed quantities');
    const commands = Array.from({ length: 100 }, (_, index) => repository.movement(context, {
      variantId: fixture.variantId, locationId: fixture.locationId, effectKey: `parallel-receipt-${index}`,
      reason: 'INTEGRATION_RECEIPT', sourceType: 'TEST', sourceReference: `fixture-${index}`, deltaPhysical: 1,
    }));
    const commandResults = await Promise.allSettled(commands);
    const failedCommands = commandResults.filter((result) => result.status === 'rejected');
    assert.deepEqual(failedCommands, [], 'all 100 concurrently submitted stock receipts must commit');

    const final = await repository.listBalances({ ...context, permission: 'inventory.read' }, { locationId: fixture.locationId });
    assert.equal(final.length, 1);
    assert.equal(final[0].physical, 100);
    assert.equal(final[0].availableToSell, 100);
    assert.equal(final[0].version, 101);
    const ledger = await pool.query(`SELECT count(*)::integer AS count,min(pool_sequence)::integer AS first,max(pool_sequence)::integer AS last,
        count(DISTINCT pool_sequence)::integer AS unique_sequences,sum(delta_physical)::integer AS physical_delta
      FROM inventory.stock_events WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3`,
    [fixture.brandId, fixture.variantId, fixture.locationId]);
    assert.deepEqual(ledger.rows[0], { count: 100, first: 2, last: 101, unique_sequences: 100, physical_delta: 100 });
    const details = await pool.query(`SELECT count(*)::integer AS count FROM inventory.stock_movements m
      JOIN inventory.stock_events e ON e.id=m.stock_event_id WHERE e.brand_id=$1 AND e.variant_id=$2 AND e.location_id=$3`,
    [fixture.brandId, fixture.variantId, fixture.locationId]);
    assert.equal(details.rows[0].count, 100, 'each event must have one physical detail');
    const outbox = await pool.query(`SELECT count(*)::integer AS count FROM platform.outbox_events
      WHERE aggregate_type='inventory.stock_pool' AND aggregate_id=$1`, [fixture.variantId]);
    assert.equal(outbox.rows[0].count, 100, 'every movement must atomically publish one outbox event');

    const duplicatePayload = { variantId: fixture.variantId, locationId: fixture.replayLocationId,
      effectKey: 'concurrent-identical-retry', reason: 'INTEGRATION_RECEIPT', sourceType: 'TEST',
      sourceReference: 'same-request', deltaPhysical: 1 };
    const simultaneousRetries = await Promise.allSettled([
      repository.movement(context, duplicatePayload), repository.movement(context, duplicatePayload),
    ]);
    assert.deepEqual(simultaneousRetries.map((result) => result.status), ['fulfilled','fulfilled']);
    const duplicateState = await repository.listBalances({ ...context, permission: 'inventory.read' }, { locationId: fixture.replayLocationId });
    assert.equal(duplicateState[0].physical, 1, 'concurrent exact retries apply one physical effect');
    const duplicateEvents = await pool.query(`SELECT count(*)::integer AS count FROM inventory.stock_events
      WHERE brand_id=$1 AND business_effect_key='concurrent-identical-retry'`, [fixture.brandId]);
    assert.equal(duplicateEvents.rows[0].count, 1);

    const replay = await repository.movement(context, { variantId: fixture.variantId, locationId: fixture.locationId,
      effectKey: 'parallel-receipt-0', reason: 'INTEGRATION_RECEIPT', sourceType: 'TEST', sourceReference: 'fixture-0', deltaPhysical: 1 });
    assert.equal(replay.replayed, true);
    await assert.rejects(repository.movement(context, { variantId: fixture.variantId, locationId: fixture.locationId,
      effectKey: 'parallel-receipt-0', reason: 'CHANGED', sourceType: 'TEST', sourceReference: 'fixture-0', deltaPhysical: 1 }),
    (error) => error.getResponse?.().code === 'IDEMPOTENCY_KEY_REUSED');

    await pool.query(`CREATE FUNCTION public.fail_inventory_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='inventory.stock.changed' AND NEW.event_payload->>'sourceReference'='force-rollback' THEN
        RAISE EXCEPTION 'INJECTED_OUTBOX_FAILURE'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER fail_inventory_outbox BEFORE INSERT ON platform.outbox_events
      FOR EACH ROW EXECUTE FUNCTION public.fail_inventory_outbox()`);
    await assert.rejects(repository.movement(context, { variantId: fixture.variantId, locationId: fixture.locationId,
      effectKey: 'rollback-command', reason: 'INTEGRATION_RECEIPT', sourceType: 'TEST', sourceReference: 'force-rollback', deltaPhysical: 1 }),
    /INJECTED_OUTBOX_FAILURE/);
    const afterFailure = await repository.listBalances({ ...context, permission: 'inventory.read' }, {});
    assert.equal(afterFailure.find((item) => item.locationId === fixture.locationId).physical, 100,
      'outbox failure must roll back pool balance and journal rows');
    const failedEvent = await pool.query(`SELECT count(*)::integer AS count FROM inventory.stock_events WHERE brand_id=$1 AND business_effect_key='rollback-command'`, [fixture.brandId]);
    assert.equal(failedEvent.rows[0].count, 0);
    await pool.query('DROP TRIGGER fail_inventory_outbox ON platform.outbox_events');

    const proposalContext = { ...context, permission: 'inventory.adjust.propose' };
    const approvalContext = { ...context, userId: fixture.reviewerId, permission: 'inventory.adjust.approve' };
    const smallAdjustment = await repository.proposeAdjustment(proposalContext, { variantId: fixture.variantId, locationId: fixture.locationId,
      expectedVersion: 101, delta: -2, reason: 'DAMAGED_DURING_COUNT', evidenceRef: 'fixture:adjustment-small', effectKey: 'small-adjustment' });
    assert.equal(smallAdjustment.approvalRequired, false, 'changes below both configured D05 thresholds remain identified as lower risk');
    await assert.rejects(repository.decideAdjustment({ ...context, permission: 'inventory.adjust.approve' }, { adjustmentId: smallAdjustment.id,
      expectedVersion: 101, decision: 'APPROVE', reason: 'Self review is not allowed.' }, 'small-self-review'),
    (error) => error.getResponse?.().code === 'BRAND_ACCESS_DENIED');
    await repository.decideAdjustment(approvalContext, { adjustmentId: smallAdjustment.id, expectedVersion: 101,
      decision: 'APPROVE', reason: 'Evidence checked by a second operator.' }, 'small-adjustment-approve');
    const largeAdjustment = await repository.proposeAdjustment(proposalContext, { variantId: fixture.variantId, locationId: fixture.locationId,
      expectedVersion: 102, delta: -11, reason: 'MATERIAL_COUNT_DIFFERENCE', evidenceRef: 'fixture:adjustment-large', effectKey: 'large-adjustment' });
    assert.equal(largeAdjustment.approvalRequired, true, 'an absolute change greater than ten units requires independent approval');
    await assert.rejects(repository.decideAdjustment({ ...context, permission: 'inventory.adjust.approve' }, { adjustmentId: largeAdjustment.id,
      expectedVersion: 102, decision: 'APPROVE', reason: 'Self review is not allowed.' }, 'large-self-review'),
    (error) => error.getResponse?.().code === 'BRAND_ACCESS_DENIED');
    await repository.decideAdjustment(approvalContext, { adjustmentId: largeAdjustment.id, expectedVersion: 102,
      decision: 'APPROVE', reason: 'Independent count evidence approved.' }, 'large-adjustment-approve');
    const adjustmentAudit = await pool.query(`SELECT count(*)::integer AS count FROM inventory.stock_adjustment_events WHERE brand_id=$1`, [fixture.brandId]);
    assert.equal(adjustmentAudit.rows[0].count, 6, 'propose, approve, and apply actions must remain auditable');

    const countContext = { ...context, permission: 'inventory.count' };
    const count = await repository.createCycleCount(countContext, { variantId: fixture.variantId, locationId: fixture.locationId,
      physical: 90, expectedVersion: 103 }, 'cycle-count-1');
    assert.equal(count.state, 'REVIEW_REQUIRED', 'count drift opens a reconciliation case without mutating authoritative stock');
    assert.ok(count.caseId);
    const cases = await repository.listReconciliationCases({ ...context, permission: 'inventory.read' });
    assert.equal(cases.length, 1);
    await assert.rejects(repository.resolveCase({ ...context, permission: 'inventory.reconcile' }, count.caseId,
      { decision: 'COMPENSATE', expectedVersion: 999, reason: 'Count reviewed; correction is linked.', adjustmentId: largeAdjustment.id }, 'reconcile-stale'),
    (error) => error.getResponse?.().code === 'STOCK_VERSION_CONFLICT');
    await repository.resolveCase({ ...context, permission: 'inventory.reconcile' }, count.caseId,
      { decision: 'COMPENSATE', expectedVersion: 1, reason: 'Count correction applied via approved movement.', adjustmentId: largeAdjustment.id }, 'reconcile-compensate');
    const resolutionEvents = await pool.query('SELECT action,actor_user_id,adjustment_id,reason FROM inventory.reconciliation_case_events WHERE case_id=$1', [count.caseId]);
    assert.equal(resolutionEvents.rows.length, 1, 'case closure must append one immutable resolution event');
    assert.equal(resolutionEvents.rows[0].action, 'COMPENSATED');
    assert.equal(resolutionEvents.rows[0].adjustment_id, largeAdjustment.id);
    await assert.rejects(pool.query(`UPDATE inventory.reconciliation_case_events SET reason='rewritten' WHERE case_id=$1`, [count.caseId]),
      /STOCK_LEDGER_APPEND_ONLY/, 'resolution audit history must not be editable');

    const transfer = await repository.transfer(proposalContext, { variantId: fixture.variantId, fromLocationId: fixture.locationId,
      toLocationId: fixture.secondLocationId, quantity: 5, reason: 'WAREHOUSE_REBALANCE', expectedFromVersion: 103 }, 'transfer-5');
    assert.equal(transfer.state, 'RECEIVED');
    assert.equal(transfer.from.physical, 82);
    assert.equal(transfer.to.physical, 5);
    assert.equal(transfer.from.physical + transfer.to.physical, 87, 'paired transfer movements conserve physical units');

    await pool.query(`CREATE FUNCTION public.fail_inventory_transfer_in() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='inventory.stock.changed' AND NEW.event_payload->>'businessEffectKey' LIKE 'transfer.%.in' THEN
        RAISE EXCEPTION 'INJECTED_TRANSFER_RECEIPT_FAILURE'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER fail_inventory_transfer_in BEFORE INSERT ON platform.outbox_events
      FOR EACH ROW EXECUTE FUNCTION public.fail_inventory_transfer_in()`);
    await assert.rejects(repository.transfer(proposalContext, { variantId: fixture.variantId, fromLocationId: fixture.locationId,
      toLocationId: fixture.secondLocationId, quantity: 2, reason: 'ROLLBACK_CHECK', expectedFromVersion: 104 }, 'transfer-rollback'), /INJECTED_TRANSFER_RECEIPT_FAILURE/);
    const afterTransferRollback = await repository.listBalances({ ...context, permission: 'inventory.read' }, {});
    assert.equal(afterTransferRollback.find((item) => item.locationId === fixture.locationId).physical, 82);
    assert.equal(afterTransferRollback.find((item) => item.locationId === fixture.secondLocationId).physical, 5);
    await pool.query('DROP TRIGGER fail_inventory_transfer_in ON platform.outbox_events');

    const submittedReturn = await repository.createReturn(context, { variantId: fixture.variantId, locationId: fixture.secondLocationId,
      quantity: 1, condition: 'INSPECT', reason: 'CUSTOMER_RETURN', evidenceReference: 'fixture:return-inspection' }, 'return-inspect');
    assert.equal(submittedReturn.state, 'PENDING_INSPECTION');
    await repository.decideReturn(approvalContext, { returnId: submittedReturn.id, expectedDecision: 'ACCEPT', reason: 'Inspection passed.' }, 'return-inspect-accept');
    const damagedReturn = await repository.createReturn(context, { variantId: fixture.variantId, locationId: fixture.secondLocationId,
      quantity: 2, condition: 'DAMAGED', reason: 'DAMAGED_RETURN', evidenceReference: 'fixture:return-damaged' }, 'return-damaged');
    await assert.rejects(repository.decideReturn(approvalContext, { returnId: damagedReturn.id, expectedDecision: 'ACCEPT', reason: 'Damage observed.' }, 'return-damaged-accept'),
      (error) => error.getResponse?.().code === 'STOCK_DAMAGED_RETURN_NOT_SELLABLE');
    await repository.decideReturn(approvalContext, { returnId: damagedReturn.id, expectedDecision: 'REJECT', reason: 'Damaged stock remains quarantined.' }, 'return-damaged-reject');
    const afterReturns = await repository.listBalances({ ...context, permission: 'inventory.read' }, {});
    const secondPool = afterReturns.find((item) => item.locationId === fixture.secondLocationId);
    assert.equal(secondPool.physical, 8);
    assert.equal(secondPool.quarantine, 2);
    assert.equal(secondPool.availableToSell, 6);

    await repository.movement(context, { variantId: fixture.variantId, locationId: fixture.secondLocationId,
      effectKey: 'replay-buffer-bucket', reason: 'INTEGRATION_BUFFER_SETUP', sourceType: 'TEST',
      sourceReference: 'buffer-replay-setup', deltaBuffer: 1 });
    await pool.query(`INSERT INTO inventory.stock_allocations(brand_id,variant_id,location_id,checkout_id,checkout_line_id,
      accepted_sequence,quantity,allocation_state) VALUES($1,$2,$3,$4,$5,1,2,'ALLOCATED')`,
    [fixture.brandId, fixture.variantId, fixture.secondLocationId, randomUUID(), randomUUID()]);
    await repository.movement(context, { variantId: fixture.variantId, locationId: fixture.secondLocationId,
      effectKey: 'replay-commitment-buckets', reason: 'INTEGRATION_COMMITMENT_SETUP', sourceType: 'TEST',
      sourceReference: 'commitment-replay-setup', deltaCommitted: 1, deltaAllocated: 1 });
    const beforeRace = (await repository.listBalances({ ...context, permission: 'inventory.read' }, {}))
      .find((item) => item.locationId === fixture.secondLocationId);
    assert.equal(beforeRace.availableToSell, 3);

    const replayCount = await repository.createCycleCount({ ...context, permission: 'inventory.count' }, {
      variantId: fixture.variantId, locationId: fixture.secondLocationId, physical: 8, expectedVersion: 7,
    }, 'cycle-count-after-transfer-return-buffer');
    assert.equal(replayCount.state, 'RECONCILED', 'journal replay reconstructs P/Q/U/A/B after transfer, returns, buffer and commitment events');

    await pool.query(`INSERT INTO inventory.stock_allocations(brand_id,variant_id,location_id,checkout_id,checkout_line_id,
      accepted_sequence,quantity,allocation_state) VALUES($1,$2,$3,$4,$5,1,3,'ALLOCATED')`,
    [fixture.brandId, fixture.variantId, fixture.secondLocationId, randomUUID(), randomUUID()]);
    const stockAttempts = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => repository.movement(context, {
      variantId: fixture.variantId, locationId: fixture.secondLocationId, effectKey: `concurrent-decrement-${index}`,
      reason: 'CONCURRENT_STOCK_CLAIM', sourceType: 'TEST', sourceReference: `claim-${index}`, deltaCommitted: 1,
    })));
    assert.equal(stockAttempts.filter((result) => result.status === 'fulfilled').length, 3);
    assert.equal(stockAttempts.filter((result) => result.status === 'rejected').length, 97);
    const afterRace = (await repository.listBalances({ ...context, permission: 'inventory.read' }, {}))
      .find((item) => item.locationId === fixture.secondLocationId);
    assert.equal(afterRace.physical, 8);
    assert.equal(afterRace.quarantine, 2);
    assert.equal(afterRace.committedUnshipped, 4);
    assert.equal(afterRace.availableToSell, 0);

    const denied = await pool.query(`UPDATE brands.brand_memberships SET membership_state='revoked' WHERE brand_id=$1 AND user_id=$2`, [fixture.brandId, fixture.actorId]);
    assert.equal(denied.rowCount, 1);
    await assert.rejects(repository.ensurePool({ ...context, permission: 'inventory.location.manage' }, fixture.variantId, fixture.locationId),
      (error) => error.getResponse?.().code === 'BRAND_ACCESS_DENIED', 'revoked membership must no longer authorize inventory access');
  } finally {
    await pool?.end();
    if (dbNameCreated) await admin.query(`DROP DATABASE "${isolatedName}"`);
    await admin.end();
  }
});
