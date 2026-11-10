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
      const openingLocation = await setup.query(`INSERT INTO inventory.stock_locations(brand_id,location_code,name)
        VALUES($1,'WH-4','Opening Receipt Warehouse') RETURNING id`, [brandId]);
      const rollbackLocation = await setup.query(`INSERT INTO inventory.stock_locations(brand_id,location_code,name)
        VALUES($1,'WH-5','Opening Rollback Warehouse') RETURNING id`, [brandId]);
      const observationLocation = await setup.query(`INSERT INTO inventory.stock_locations(brand_id,location_code,name)
        VALUES($1,'WH-6','Observation Review Warehouse') RETURNING id`, [brandId]);
      await setup.query('COMMIT');
      fixture = { actorId, reviewerId, brandId, variantId: variant.rows[0].id, locationId: location.rows[0].id,
        secondLocationId: secondLocation.rows[0].id, replayLocationId: replayLocation.rows[0].id,
        openingLocationId: openingLocation.rows[0].id, rollbackLocationId: rollbackLocation.rows[0].id,
        observationLocationId: observationLocation.rows[0].id };
    } catch (error) { await setup.query('ROLLBACK'); throw error; }
    finally { setup.release(); }

    const repository = new InventoryPostgresRepository({ pool });
    const context = { userId: fixture.actorId, brandId: fixture.brandId, permission: 'inventory.submit' };
    await repository.ensurePool(context, fixture.variantId, fixture.secondLocationId);
    await repository.ensurePool(context, fixture.variantId, fixture.observationLocationId);
    const genesis = await pool.query(`SELECT e.pool_sequence,e.event_kind,m.movement_reason,m.delta_physical
      FROM inventory.stock_events e JOIN inventory.stock_movements m ON m.stock_event_id=e.id
      WHERE e.brand_id=$1 AND e.variant_id=$2 AND e.location_id=$3 AND e.business_effect_key LIKE 'genesis.%'`,
    [fixture.brandId, fixture.variantId, fixture.secondLocationId]);
    assert.deepEqual(genesis.rows, [{ pool_sequence: '1', event_kind: 'PHYSICAL', movement_reason: 'GENESIS', delta_physical: '0' }],
      'an empty stock pool has an explicit immutable zero-state genesis at sequence one');

    const opening = await repository.openingReceipt(context, { variantId: fixture.variantId, locationId: fixture.openingLocationId,
      quantity: 10, unit: 'EACH', sourceType: 'INITIAL_COUNT', sourceReference: 'opening-count-1' }, 'opening-receipt-10');
    assert.equal(opening.physical, 10);
    assert.equal(opening.opened, true);
    assert.equal(opening.version, 2, 'genesis is sequence one and the opening receipt is sequence two');
    const openingReplay = await repository.openingReceipt(context, { variantId: fixture.variantId, locationId: fixture.openingLocationId,
      quantity: 10, unit: 'EACH', sourceType: 'INITIAL_COUNT', sourceReference: 'opening-count-1' }, 'opening-receipt-10');
    assert.equal(openingReplay.physical, 10, 'the first receipt is safely replayable');
    await pool.query(`CREATE FUNCTION public.fail_opening_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='inventory.stock.changed' AND NEW.event_payload->>'sourceReference'='opening-rollback' THEN
        RAISE EXCEPTION 'INJECTED_OPENING_RECEIPT_FAILURE'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER fail_opening_receipt BEFORE INSERT ON platform.outbox_events
      FOR EACH ROW EXECUTE FUNCTION public.fail_opening_receipt()`);
    await assert.rejects(repository.openingReceipt(context, { variantId: fixture.variantId, locationId: fixture.rollbackLocationId,
      quantity: 4, unit: 'EACH', sourceType: 'INITIAL_COUNT', sourceReference: 'opening-rollback' }, 'opening-receipt-rollback'), /INJECTED_OPENING_RECEIPT_FAILURE/);
    const rolledBackPool = await pool.query(`SELECT count(*)::integer AS count FROM inventory.stock_balances
      WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3`, [fixture.brandId, fixture.variantId, fixture.rollbackLocationId]);
    assert.equal(rolledBackPool.rows[0].count, 0, 'a failed first receipt rolls back zero-pool creation too');
    await pool.query('DROP TRIGGER fail_opening_receipt ON platform.outbox_events');
    await pool.query('DROP FUNCTION public.fail_opening_receipt()');

    const initialAsOf = new Date(Date.now() - 3000).toISOString();
    const newerAsOf = new Date(Date.now() - 2000).toISOString();
    const observationInput = { variantId: fixture.variantId, locationId: fixture.secondLocationId,
      sourceNamespace: 'SHOPIFY', sourceReference: 'inventory-item-1', sourceVersion: '1',
      asOf: initialAsOf, meaning: 'physical', quantity: 12 };
    const initialObservation = await repository.submitObservation(context, observationInput, 'observation-1');
    assert.equal(initialObservation.freshness, 'CURRENT');
    const newerObservation = await repository.submitObservation(context, { ...observationInput,
      sourceVersion: '2', asOf: newerAsOf, quantity: 13 }, 'observation-2');
    assert.equal(newerObservation.freshness, 'CURRENT', 'newer feed observations from the same source reference must be retained');
    const staleObservation = await repository.submitObservation(context, { ...observationInput,
      asOf: new Date(Date.now() - 4000).toISOString(), quantity: 11 }, 'observation-3');
    assert.equal(staleObservation.freshness, 'STALE', 'older feed observations must remain visible as stale');
    await assert.rejects(repository.proposeAdjustmentFromObservation({ ...context, permission: 'inventory.adjust.propose' }, staleObservation.id,
      'STALE_COUNT', 'stale-observation-adjustment'),
    (error) => error.getResponse?.().code === 'STOCK_OBSERVATION_REQUIRES_REVIEW',
    'a stale external snapshot cannot enter the adjustment workflow');
    const conflictingObservation = await repository.submitObservation(context, { ...observationInput,
      sourceVersion: '2-conflict', asOf: newerAsOf, quantity: 14 }, 'observation-4');
    assert.equal(conflictingObservation.freshness, 'CONFLICT', 'same-time different-quantity observations must be retained as conflicts');
    const observationRows = await pool.query(`SELECT count(*)::integer AS count FROM inventory.stock_observations
      WHERE brand_id=$1 AND source_namespace='SHOPIFY' AND source_reference='inventory-item-1'`, [fixture.brandId]);
    assert.equal(observationRows.rows[0].count, 4);
    const observedPool = (await repository.listBalances({ ...context, permission: 'inventory.read' }, { locationId: fixture.secondLocationId }))[0];
    assert.equal(observedPool.physical, 0, 'external observations must not overwrite authoritative physical stock');

    const now = Date.now();
    const alertObservation = await repository.submitObservation(context, { ...observationInput,
      locationId: fixture.observationLocationId, sourceReference: 'manual-alert', asOf: new Date(now - 25 * 60 * 60_000).toISOString(), quantity: 3 }, 'observation-manual-alert');
    const pausedObservation = await repository.submitObservation(context, { ...observationInput,
      locationId: fixture.observationLocationId, sourceReference: 'manual-paused', asOf: new Date(now - 49 * 60 * 60_000).toISOString(), quantity: 4 }, 'observation-manual-paused');
    const connectedAlert = await repository.submitObservation(context, { ...observationInput,
      locationId: fixture.observationLocationId, sourceReference: 'connected-alert', asOf: new Date(now - 16 * 60_000).toISOString(), quantity: 5, sourceMode: 'CONNECTED' }, 'observation-connected-alert');
    const connectedPaused = await repository.submitObservation(context, { ...observationInput,
      locationId: fixture.observationLocationId, sourceReference: 'connected-paused', asOf: new Date(now - 61 * 60_000).toISOString(), quantity: 6, sourceMode: 'CONNECTED' }, 'observation-connected-paused');
    assert.equal(alertObservation.freshness, 'ALERT');
    assert.equal(pausedObservation.freshness, 'PAUSED');
    assert.equal(connectedAlert.freshness, 'ALERT');
    assert.equal(connectedPaused.freshness, 'PAUSED');
    const observationSignals = await repository.listObservations({ ...context, permission: 'inventory.read' }, 100);
    assert.ok(observationSignals.some((item) => item.id === conflictingObservation.id && item.freshness === 'CONFLICT'));
    assert.ok(observationSignals.some((item) => item.id === alertObservation.id && item.freshness === 'ALERT'));
    assert.ok(observationSignals.some((item) => item.id === pausedObservation.id && item.freshness === 'PAUSED'));
    assert.ok(observationSignals.some((item) => item.id === connectedAlert.id && item.freshness === 'ALERT'));
    assert.ok(observationSignals.some((item) => item.id === connectedPaused.id && item.freshness === 'PAUSED'));
    const reviewObservation = await repository.submitObservation(context, { ...observationInput,
      locationId: fixture.observationLocationId, sourceReference: 'reviewed-count', quantity: 3 }, 'observation-reviewed-count');
    const adjustmentContext = { ...context, permission: 'inventory.adjust.propose' };
    const observationAdjustment = await repository.proposeAdjustmentFromObservation(adjustmentContext, reviewObservation.id,
      'REVIEWED_PHYSICAL_COUNT', 'observation-adjustment-1');
    assert.equal((await repository.listBalances({ ...context, permission: 'inventory.read' }, { locationId: fixture.observationLocationId }))[0].physical, 0,
      'a proposed observation correction never changes authoritative stock');
    await repository.decideAdjustment({ ...context, userId: fixture.reviewerId, permission: 'inventory.adjust.approve' }, {
      adjustmentId: observationAdjustment.id, expectedVersion: 1, decision: 'APPROVE', reason: 'Independent count review passed.' }, 'observation-adjustment-approve');
    const reviewedBalance = (await repository.listBalances({ ...context, permission: 'inventory.read' }, { locationId: fixture.observationLocationId }))[0];
    assert.equal(reviewedBalance.physical, 3, 'only an approved movement converts the observation into authoritative physical stock');
    const reviewedSignal = (await repository.listObservations({ ...context, permission: 'inventory.read' }, 100)).find((item) => item.id === reviewObservation.id);
    assert.equal(reviewedSignal.review_state, 'ACCEPTED');
    assert.equal(reviewedSignal.freshness, 'REVIEW_REQUIRED', 'source snapshots become review-required when the pool advances');

    await assert.rejects(pool.query(`UPDATE inventory.stock_balances SET physical_on_hand=10,quarantined=3,
      other_non_sellable=8,allocated_not_dispatched=2 WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3`,
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
      FROM inventory.stock_events WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 AND business_effect_key NOT LIKE 'genesis.%'`,
    [fixture.brandId, fixture.variantId, fixture.locationId]);
    assert.deepEqual(ledger.rows[0], { count: 100, first: 2, last: 101, unique_sequences: 100, physical_delta: 100 });
    const details = await pool.query(`SELECT count(*)::integer AS count FROM inventory.stock_movements m
      JOIN inventory.stock_events e ON e.id=m.stock_event_id WHERE e.brand_id=$1 AND e.variant_id=$2 AND e.location_id=$3
        AND e.business_effect_key NOT LIKE 'genesis.%'`,
    [fixture.brandId, fixture.variantId, fixture.locationId]);
    assert.equal(details.rows[0].count, 100, 'each event must have one physical detail');
    await assert.rejects(pool.query(`INSERT INTO inventory.stock_movements(
      stock_event_id,brand_id,variant_id,location_id,delta_physical,movement_reason,business_effect_key,
      source_type,source_reference,balance_version_after)
      SELECT stock_event_id,brand_id,variant_id,location_id,delta_physical,'DUPLICATE_DETAIL',
        'duplicate-detail-effect','TEST','duplicate-detail',balance_version_after
      FROM inventory.stock_movements WHERE brand_id=$1 AND business_effect_key='parallel-receipt-0'`, [fixture.brandId]),
    (error) => error.code === '23505', 'a committed event must reject a second detail in a later transaction');
    const outbox = await pool.query(`SELECT count(*)::integer AS count FROM platform.outbox_events
      WHERE aggregate_type='inventory.stock_pool' AND aggregate_id=$1 AND event_payload->>'brandId'=$2
        AND event_payload->>'locationId'=$3 AND event_payload->>'eventKind'<>'GENESIS'`, [fixture.variantId, fixture.brandId, fixture.locationId]);
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
    const policyHistory = await pool.query(`SELECT version,absolute_units,percentage,source_status FROM inventory.stock_adjustment_policy_history WHERE policy_key='D05'`);
    assert.equal(policyHistory.rowCount, 1, 'the seeded D05 policy must have an immutable history record');
    await assert.rejects(pool.query(`UPDATE inventory.stock_adjustment_policy SET absolute_units=11 WHERE policy_key='D05'`),
      /STOCK_ADJUSTMENT_POLICY_VERSION_REQUIRED/, 'policy thresholds cannot change without a new version');
    const smallAdjustment = await repository.proposeAdjustment(proposalContext, { variantId: fixture.variantId, locationId: fixture.locationId,
      expectedVersion: 101, delta: -2, reason: 'DAMAGED_DURING_COUNT', evidenceRef: 'fixture:adjustment-small', effectKey: 'small-adjustment' });
    assert.equal(smallAdjustment.approvalRequired, false, 'changes below both configured D05 thresholds remain identified as lower risk');
    const draftedAdjustments = await repository.listAdjustments({ ...context, permission: 'inventory.read' }, 100);
    const draftedSmall = draftedAdjustments.find((item) => item.id === smallAdjustment.id);
    assert.equal(draftedSmall.physical_before, '100');
    assert.equal(draftedSmall.physical_after, '98');
    assert.deepEqual(draftedSmall.history.map((event) => event.action), ['PROPOSED']);
    await assert.rejects(repository.decideAdjustment({ ...context, permission: 'inventory.adjust.approve' }, { adjustmentId: smallAdjustment.id,
      expectedVersion: 101, decision: 'APPROVE', reason: 'Self review is not allowed.' }, 'small-self-review'),
    (error) => error.getResponse?.().code === 'BRAND_ACCESS_DENIED');
    await repository.decideAdjustment(approvalContext, { adjustmentId: smallAdjustment.id, expectedVersion: 101,
      decision: 'APPROVE', reason: 'Evidence checked by a second operator.' }, 'small-adjustment-approve');
    const approvedAdjustments = await repository.listAdjustments({ ...context, permission: 'inventory.read' }, 100);
    const approvedSmall = approvedAdjustments.find((item) => item.id === smallAdjustment.id);
    assert.deepEqual(approvedSmall.history.map((event) => event.action), ['PROPOSED', 'APPROVED', 'APPLIED']);
    const largeAdjustment = await repository.proposeAdjustment(proposalContext, { variantId: fixture.variantId, locationId: fixture.locationId,
      expectedVersion: 102, delta: -11, reason: 'MATERIAL_COUNT_DIFFERENCE', evidenceRef: 'fixture:adjustment-large', effectKey: 'large-adjustment' });
    assert.equal(largeAdjustment.approvalRequired, true, 'an absolute change greater than ten units requires independent approval');
    await assert.rejects(repository.decideAdjustment({ ...context, permission: 'inventory.adjust.approve' }, { adjustmentId: largeAdjustment.id,
      expectedVersion: 102, decision: 'APPROVE', reason: 'Self review is not allowed.' }, 'large-self-review'),
    (error) => error.getResponse?.().code === 'BRAND_ACCESS_DENIED');
    await repository.decideAdjustment(approvalContext, { adjustmentId: largeAdjustment.id, expectedVersion: 102,
      decision: 'APPROVE', reason: 'Independent count evidence approved.' }, 'large-adjustment-approve');
    const adjustmentAudit = await pool.query(`SELECT count(*)::integer AS count FROM inventory.stock_adjustment_events WHERE brand_id=$1`, [fixture.brandId]);
    assert.equal(adjustmentAudit.rows[0].count, 9, 'ordinary and observation-backed propose, approve, and apply actions must remain auditable');

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
    await assert.rejects(repository.resolveCase({ ...context, permission: 'inventory.reconcile' }, count.caseId,
      { decision: 'COMPENSATE', expectedVersion: 1, reason: 'Prior adjustment is unrelated to this count.', adjustmentId: largeAdjustment.id }, 'reconcile-unrelated-adjustment'),
    (error) => error.getResponse?.().code === 'STOCK_RECONCILIATION_ADJUSTMENT_REQUIRED',
    'a previously applied adjustment must not compensate a later count discrepancy');
    const caseAdjustment = await repository.proposeAdjustment(proposalContext, { variantId: fixture.variantId, locationId: fixture.locationId,
      expectedVersion: 103, delta: 3, reason: 'CYCLE_COUNT_CORRECTION', evidenceRef: 'fixture:cycle-count-1',
      effectKey: 'cycle-count-correction', reconciliationCaseId: count.caseId });
    await repository.decideAdjustment(approvalContext, { adjustmentId: caseAdjustment.id, expectedVersion: 103,
      decision: 'APPROVE', reason: 'Count evidence independently reviewed.' }, 'cycle-count-correction-approve');
    const correctedBalance = (await repository.listBalances({ ...context, permission: 'inventory.read' }, { locationId: fixture.locationId }))[0];
    assert.equal(correctedBalance.physical, 90, 'case compensation must apply the exact measured discrepancy before closure');
    await repository.resolveCase({ ...context, permission: 'inventory.reconcile' }, count.caseId,
      { decision: 'COMPENSATE', expectedVersion: 1, reason: 'Count correction applied via approved movement.', adjustmentId: caseAdjustment.id }, 'reconcile-compensate');
    const resolutionEvents = await pool.query('SELECT action,actor_user_id,adjustment_id,reason FROM inventory.reconciliation_case_events WHERE case_id=$1', [count.caseId]);
    assert.equal(resolutionEvents.rows.length, 1, 'case closure must append one immutable resolution event');
    assert.equal(resolutionEvents.rows[0].action, 'COMPENSATED');
    assert.equal(resolutionEvents.rows[0].adjustment_id, caseAdjustment.id);
    await assert.rejects(pool.query(`UPDATE inventory.reconciliation_case_events SET reason='rewritten' WHERE case_id=$1`, [count.caseId]),
      /STOCK_LEDGER_APPEND_ONLY/, 'resolution audit history must not be editable');

    const transfer = await repository.transfer(proposalContext, { variantId: fixture.variantId, fromLocationId: fixture.locationId,
      toLocationId: fixture.secondLocationId, quantity: 5, reason: 'WAREHOUSE_REBALANCE', expectedFromVersion: 104 }, 'transfer-5');
    assert.equal(transfer.state, 'IN_TRANSIT');
    assert.equal(transfer.from.physical, 85);
    const beforeReceipt = (await repository.listBalances({ ...context, permission: 'inventory.read' }, {}))
      .find((item) => item.locationId === fixture.secondLocationId);
    assert.equal(beforeReceipt.physical, 0, 'in-transit stock must not be counted at the destination before receipt');
    const receipt = await repository.receiveTransfer(proposalContext, transfer.id, transfer.destinationVersion, 'transfer-5-receive');
    assert.equal(receipt.state, 'RECEIVED');
    assert.equal(receipt.destination.physical, 5);
    assert.equal(transfer.from.physical + receipt.destination.physical, 90, 'completed transfer movements conserve physical units');

    await pool.query(`CREATE FUNCTION public.fail_inventory_transfer_in() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='inventory.stock.changed' AND NEW.event_payload->>'businessEffectKey' LIKE 'transfer.%.in' THEN
        RAISE EXCEPTION 'INJECTED_TRANSFER_RECEIPT_FAILURE'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER fail_inventory_transfer_in BEFORE INSERT ON platform.outbox_events
      FOR EACH ROW EXECUTE FUNCTION public.fail_inventory_transfer_in()`);
    const rollbackTransfer = await repository.transfer(proposalContext, { variantId: fixture.variantId, fromLocationId: fixture.locationId,
      toLocationId: fixture.secondLocationId, quantity: 2, reason: 'ROLLBACK_CHECK', expectedFromVersion: 105 }, 'transfer-rollback');
    await assert.rejects(repository.receiveTransfer(proposalContext, rollbackTransfer.id, rollbackTransfer.destinationVersion, 'transfer-rollback-receive'), /INJECTED_TRANSFER_RECEIPT_FAILURE/);
    const afterTransferRollback = await repository.listBalances({ ...context, permission: 'inventory.read' }, {});
    assert.equal(afterTransferRollback.find((item) => item.locationId === fixture.locationId).physical, 83);
    assert.equal(afterTransferRollback.find((item) => item.locationId === fixture.secondLocationId).physical, 5);
    await pool.query('DROP TRIGGER fail_inventory_transfer_in ON platform.outbox_events');

    const submittedReturn = await repository.createReturn(context, { variantId: fixture.variantId, locationId: fixture.secondLocationId,
      quantity: 1, condition: 'INSPECT', reason: 'CUSTOMER_RETURN', evidenceReference: 'fixture:return-inspection' }, 'return-inspect');
    assert.equal(submittedReturn.state, 'PENDING_INSPECTION');
    const submittedReturnReplay = await repository.createReturn(context, { variantId: fixture.variantId, locationId: fixture.secondLocationId,
      quantity: 1, condition: 'INSPECT', reason: 'CUSTOMER_RETURN', evidenceReference: 'fixture:return-inspection' }, 'return-inspect');
    assert.equal(submittedReturnReplay.id, submittedReturn.id, 'duplicate return intake reuses the same quarantined return');
    const acceptedReturn = await repository.decideReturn(approvalContext,
      { returnId: submittedReturn.id, expectedDecision: 'ACCEPT', reason: 'Inspection passed.' }, 'return-inspect-accept');
    const acceptedReturnReplay = await repository.decideReturn(approvalContext,
      { returnId: submittedReturn.id, expectedDecision: 'ACCEPT', reason: 'Inspection passed.' }, 'return-inspect-accept');
    assert.equal(acceptedReturnReplay.id, acceptedReturn.id, 'duplicate return review reuses the recorded decision');
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
    await repository.movement(context, { variantId: fixture.variantId, locationId: fixture.secondLocationId,
      effectKey: 'replay-buffer-third-unit', reason: 'INTEGRATION_BUFFER_SETUP', sourceType: 'TEST',
      sourceReference: 'buffer-replay-three-unit-race', deltaBuffer: 1 });
    const firstAllocation = await pool.query(`INSERT INTO inventory.stock_allocations(brand_id,variant_id,location_id,checkout_id,checkout_line_id,
      accepted_sequence,quantity,allocation_state) VALUES($1,$2,$3,$4,$5,1,2,'ALLOCATED') RETURNING id`,
    [fixture.brandId, fixture.variantId, fixture.secondLocationId, randomUUID(), randomUUID()]);
    await repository.movement(context, { variantId: fixture.variantId, locationId: fixture.secondLocationId,
      effectKey: 'replay-commitment-buckets', reason: 'INTEGRATION_COMMITMENT_SETUP', sourceType: 'TEST',
      sourceReference: 'commitment-replay-setup', allocationId: firstAllocation.rows[0].id, deltaAllocated: 1 });
    const beforeRace = (await repository.listBalances({ ...context, permission: 'inventory.read' }, {}))
      .find((item) => item.locationId === fixture.secondLocationId);
    assert.equal(beforeRace.availableToSell, 3);

    const replayCount = await repository.createCycleCount({ ...context, permission: 'inventory.count' }, {
      variantId: fixture.variantId, locationId: fixture.secondLocationId, physical: 8, expectedVersion: 8,
    }, 'cycle-count-after-transfer-return-buffer');
    assert.equal(replayCount.state, 'RECONCILED', 'journal replay reconstructs P/Q/U/A/B after transfer, returns, buffer and commitment events');

    const raceAllocations = [];
    for (let index = 0; index < 3; index += 1) {
      const row = await pool.query(`INSERT INTO inventory.stock_allocations(brand_id,variant_id,location_id,checkout_id,checkout_line_id,
        accepted_sequence,quantity,allocation_state) VALUES($1,$2,$3,$4,$5,$6,1,'ALLOCATED') RETURNING id`,
      [fixture.brandId, fixture.variantId, fixture.secondLocationId, randomUUID(), randomUUID(), index + 2]);
      raceAllocations.push(row.rows[0].id);
    }
    const stockAttempts = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => repository.movement(context, {
      variantId: fixture.variantId, locationId: fixture.secondLocationId, effectKey: `concurrent-decrement-${index}`,
      reason: 'CONCURRENT_STOCK_CLAIM', sourceType: 'TEST', sourceReference: `claim-${index}`, allocationId: raceAllocations[index % 3], deltaAllocated: 1,
    })));
    assert.equal(stockAttempts.filter((result) => result.status === 'fulfilled').length, 3);
    assert.equal(stockAttempts.filter((result) => result.status === 'rejected').length, 97);
    const afterRace = (await repository.listBalances({ ...context, permission: 'inventory.read' }, {}))
      .find((item) => item.locationId === fixture.secondLocationId);
    assert.equal(afterRace.physical, 8);
    assert.equal(afterRace.quarantine, 2);
    assert.equal(afterRace.allocatedNotDispatched, 4);
    assert.equal(afterRace.availableToSell, 0);
    await assert.rejects(repository.movement(context, { variantId: fixture.variantId, locationId: fixture.secondLocationId,
      effectKey: 'physical-decrease-below-commitments', reason: 'INTEGRATION_COMMITMENT_GUARD', sourceType: 'TEST',
      sourceReference: 'decrease-under-allocated-stock', deltaPhysical: -1 }),
    (error) => error.getResponse?.().code === 'STOCK_BALANCE_INVALID',
    'physical movement must not reduce P below already allocated stock or buffer');
    const raceDetails = await pool.query(`SELECT count(DISTINCT allocation_id)::integer AS allocations,count(*)::integer AS events
      FROM inventory.stock_commitment_events WHERE brand_id=$1 AND allocation_id=ANY($2::uuid[])`, [fixture.brandId, raceAllocations]);
    assert.deepEqual(raceDetails.rows[0], { allocations: 3, events: 3 }, 'three distinct allocation records must win the 100-command race');

    const gapSetup = await repository.movement(context, { variantId: fixture.variantId, locationId: fixture.replayLocationId,
      effectKey: 'journal-gap-setup', reason: 'INTEGRATION_RECEIPT', sourceType: 'TEST', sourceReference: 'journal-gap-setup', deltaPhysical: 1 });
    await pool.query(`UPDATE inventory.stock_balances SET row_version=row_version+1 WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3`,
    [fixture.brandId, fixture.variantId, fixture.replayLocationId]);
    const gapCount = await repository.createCycleCount({ ...context, permission: 'inventory.count' }, {
      variantId: fixture.variantId, locationId: fixture.replayLocationId, physical: 1, expectedVersion: gapSetup.version + 1,
    }, 'cycle-count-journal-gap');
    assert.equal(gapCount.state, 'REVIEW_REQUIRED', 'a sequence/version gap must never be reported as reconciled');
    const gapCase = (await repository.listReconciliationCases({ ...context, permission: 'inventory.read' }))
      .find((item) => item.id === gapCount.caseId);
    assert.equal(gapCase.reason_code, 'JOURNAL_SEQUENCE_GAP');

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
