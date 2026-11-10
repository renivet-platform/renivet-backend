'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { DurableWorker } = require('../dist/workers/durable-worker.js');
const { DatabaseWorkerAuthorizationService } = require('../dist/workers/worker-authorization.js');

function disposableUrl() {
  const raw = process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(raw, 'RENIVET_TEST_DATABASE_URL is required');
  const url = new URL(raw);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/renivet_ci');
  assert.equal(url.username, 'renivet_ci');
  return raw;
}

test('REN2-51 denies cross-brand media and stock replays and preserves authorization audit', { timeout: 30_000 }, async (t) => {
  const pool = new Pool({ connectionString: disposableUrl(), max: 8, connectionTimeoutMillis: 5000 });
  t.after(() => pool.end());
  const tag = `ren2-51-${randomUUID()}`;
  const brandA = (await pool.query(
    `INSERT INTO brands.brands (slug, legal_name, display_name, onboarding_state)
     VALUES ($1, 'REN2-51 Synthetic A', 'REN2-51 Synthetic A', 'approved') RETURNING id`, [`${tag}-a`],
  )).rows[0].id;
  const brandB = (await pool.query(
    `INSERT INTO brands.brands (slug, legal_name, display_name, onboarding_state)
     VALUES ($1, 'REN2-51 Synthetic B', 'REN2-51 Synthetic B', 'approved') RETURNING id`, [`${tag}-b`],
  )).rows[0].id;
  const category = (await pool.query(
    `INSERT INTO catalogue.categories (code, name) VALUES ($1, 'REN2-51 Synthetic') RETURNING id`, [tag],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO catalogue.category_schema_versions (category_id, version, ruleset_sha256, validator_version)
     VALUES ($1, 1, repeat('b', 64), 'ren2-51-test')`, [category],
  );
  const product = (await pool.query(
    `INSERT INTO catalogue.products (brand_id, category_id, style_code, title, category_schema_version)
     VALUES ($1, $2, $3, 'REN2-51 Synthetic', 1) RETURNING id`, [brandA, category, `${tag}-style`],
  )).rows[0].id;
  const variant = (await pool.query(
    `INSERT INTO catalogue.product_variants (brand_id, product_id, sku, option_signature, options)
     VALUES ($1, $2, $3, 'default', '{}'::jsonb) RETURNING id`, [brandA, product, `R51${randomUUID().replaceAll('-', '').slice(0, 12)}`],
  )).rows[0].id;
  const location = (await pool.query(
    `INSERT INTO inventory.stock_locations (brand_id, location_code, name) VALUES ($1, $2, 'REN2-51') RETURNING id`, [brandA, tag],
  )).rows[0].id;
  await pool.query('INSERT INTO inventory.stock_balances (brand_id, variant_id, location_id) VALUES ($1, $2, $3)', [brandA, variant, location]);
  const stockClient = await pool.connect();
  let stockEvent;
  try {
    await stockClient.query('BEGIN');
    const zeroBalance = { physical: 0, quarantine: 0, otherNonSellable: 0, allocatedNotDispatched: 0, buffer: 0, availableToSell: 0, version: 1 };
    const receiptBalance = { ...zeroBalance, physical: 1, availableToSell: 1, version: 2 };
    const genesisKey = `genesis.${variant}.${location}`;
    const genesis = (await stockClient.query(
      `INSERT INTO inventory.stock_events
         (brand_id,variant_id,location_id,pool_sequence,event_kind,business_effect_key,payload_sha256,
          before_balance,after_balance)
       VALUES($1,$2,$3,1,'PHYSICAL',$4,$5,$6::jsonb,$6::jsonb) RETURNING id`,
      [brandA, variant, location, genesisKey, createHash('sha256').update(`${tag}:genesis`).digest('hex'), JSON.stringify(zeroBalance)],
    )).rows[0].id;
    await stockClient.query(
      `INSERT INTO inventory.stock_movements
         (stock_event_id,brand_id,variant_id,location_id,delta_physical,movement_reason,business_effect_key,
          source_type,source_reference,balance_version_after)
       VALUES($1,$2,$3,$4,0,'GENESIS',$5,'SYSTEM',$6,1)`,
      [genesis, brandA, variant, location, genesisKey, `pool:${variant}:${location}`],
    );
    stockEvent = (await stockClient.query(
      `INSERT INTO inventory.stock_events
         (brand_id,variant_id,location_id,pool_sequence,event_kind,business_effect_key,payload_sha256,
          delta_physical,before_balance,after_balance)
       VALUES($1,$2,$3,2,'PHYSICAL',$4,$5,1,$6::jsonb,$7::jsonb) RETURNING id`,
      [brandA, variant, location, tag, createHash('sha256').update(tag).digest('hex'), JSON.stringify(zeroBalance), JSON.stringify(receiptBalance)],
    )).rows[0].id;
    await stockClient.query(
      `INSERT INTO inventory.stock_movements
         (stock_event_id,brand_id,variant_id,location_id,delta_physical,movement_reason,business_effect_key,
          source_type,source_reference,balance_version_after)
       VALUES($1,$2,$3,$4,1,'TEST_RECEIPT',$5,'TEST',$6,2)`,
      [stockEvent, brandA, variant, location, tag, tag],
    );
    await stockClient.query('COMMIT');
  } catch (error) {
    await stockClient.query('ROLLBACK');
    throw error;
  } finally {
    stockClient.release();
  }
  const mediaAsset = (await pool.query(
    `INSERT INTO media.media_assets (brand_id, storage_key, sha256, mime_type)
     VALUES ($1, $2, $3, 'image/jpeg') RETURNING id`,
    [brandA, tag, createHash('sha256').update(`${tag}:asset`).digest('hex')],
  )).rows[0].id;

  const eventRows = [];
  for (const fixture of [
    { aggregateType: 'media_asset', aggregateId: mediaAsset, eventType: 'media.asset.process', brandId: brandB },
    { aggregateType: 'stock_event', aggregateId: stockEvent, eventType: 'inventory.stock.process' },
    { aggregateType: 'media_asset', aggregateId: mediaAsset, eventType: 'media.asset.target_mismatch', brandId: brandA, targetBrandId: brandB },
    { aggregateType: 'media_asset', aggregateId: mediaAsset, eventType: 'media.asset.disallowed_effect', brandId: brandA },
  ]) {
    const row = await pool.query(
      `INSERT INTO platform.outbox_events
         (aggregate_type, aggregate_id, event_type, event_version, event_payload, event_key)
       VALUES ($1, $2, $3, 1, $4::jsonb, $5) RETURNING id`,
      [fixture.aggregateType, fixture.aggregateId, fixture.eventType, JSON.stringify({ brandId: fixture.brandId ?? brandB, ...(fixture.targetBrandId ? { targetBrandId: fixture.targetBrandId } : {}) }), `${tag}:${fixture.eventType}`],
    );
    eventRows.push(row.rows[0].id);
  }
  const allowedEvent = (await pool.query(
    `INSERT INTO platform.outbox_events
       (aggregate_type, aggregate_id, event_type, event_version, event_payload, event_key)
     VALUES ('media_asset', $1, 'media.asset.process', 1, $2::jsonb, $3) RETURNING id`,
    [mediaAsset, JSON.stringify({ brandId: brandA }), `${tag}:media.asset.allowed`],
  )).rows[0].id;
  eventRows.push(allowedEvent);

  const effects = [];
  const consumerId = 'ren2_51_brand_worker';
  const workerPrincipalId = randomUUID();
  const handler = {
    consumerId,
    eventTypes: ['media.asset.process', 'inventory.stock.process', 'media.asset.target_mismatch', 'media.asset.disallowed_effect'],
    authorization: { scope: 'brand', purpose: 'media.stock.process', effects: ['media.process', 'stock.process'] },
    async handle(event, _transaction, authorizationContext) {
      const targetBrandId = event.eventPayload.targetBrandId ?? event.eventPayload.brandId;
      const effectKey = event.eventType === 'media.asset.disallowed_effect' ? 'media.delete' : 'media.process';
      await authorizationContext.authorizeEffect(effectKey, targetBrandId);
      effects.push(event.id);
    },
  };
  const authorization = new DatabaseWorkerAuthorizationService(pool, {
    async authenticate() {
      return { id: workerPrincipalId, active: true, permittedConsumers: [consumerId], provenance: 'internal.service.port' };
    },
  });
  const worker = new DurableWorker(pool, [handler], { maxAttempts: 1, workerAuthorization: authorization });
  const result = await worker.runOnce(consumerId, `${tag}:worker`, 10);
  assert.equal(result.claimed, 5);
  assert.equal(result.processed, 1);
  assert.equal(result.deadLetter, 4);
  assert.deepEqual(effects, [allowedEvent], 'only same-brand work reaches the handler');

  const decisions = await pool.query(
    `SELECT source_event_id, brand_id, source_brand_id, target_brand_id, decision, reason_code
     FROM platform.worker_authorization_audit WHERE job_id IN (
       SELECT id FROM platform.durable_jobs WHERE job_kind = $1 AND business_key = ANY($2::text[])
     ) ORDER BY source_event_id`, [consumerId, eventRows],
  );
  assert.equal(decisions.rowCount, 6);
  const targetMismatches = decisions.rows.filter((row) => row.decision === 'denied' && row.reason_code === 'TARGET_BRAND_MISMATCH');
  const disallowedEffects = decisions.rows.filter((row) => row.decision === 'denied' && row.reason_code === 'EFFECT_NOT_ALLOWLISTED');
  assert.equal(targetMismatches.length, 3);
  assert.equal(disallowedEffects.length, 1);
  assert.ok(targetMismatches.every((row) => row.brand_id === brandA && row.source_brand_id === brandA && row.target_brand_id === brandB));
  assert.ok(disallowedEffects.every((row) => row.brand_id === brandA && row.source_brand_id === brandA && row.target_brand_id === brandA));
  assert.equal(decisions.rows.filter((row) => row.decision === 'allowed').length, 2, 'allowed effects are audited with the committed handler transaction');
  const bindings = await pool.query(
    `SELECT source_event_id, brand_id, purpose, permitted_effects
     FROM platform.worker_job_authorizations WHERE source_event_id = ANY($1::uuid[])`, [eventRows],
  );
  assert.equal(bindings.rowCount, 5);
  assert.ok(bindings.rows.every((row) => row.brand_id === brandA), 'persisted job scope must be resolved from the source aggregate, never payload.brandId');
  await assert.rejects(
    pool.query(`UPDATE platform.worker_authorization_audit SET reason_code = 'TAMPERED' WHERE source_event_id = $1`, [allowedEvent]),
    /append-only/,
  );
  await assert.rejects(
    pool.query(`UPDATE platform.worker_job_authorizations SET actor_id = 'tampered' WHERE source_event_id = $1`, [allowedEvent]),
    /immutable/,
  );

  const checkoutConsumer = 'ren2_51_checkout_admission_auth';
  const checkoutEvents = [];
  for (const [name, payloadBrandId] of [['valid', brandA], ['payload_spoof', brandB]]) {
    const checkoutId = randomUUID();
    const checkoutEvent = (await pool.query(
      `INSERT INTO platform.outbox_events
         (aggregate_type, aggregate_id, event_type, event_version, event_payload, event_key)
       VALUES ('checkout.order', $1, 'checkout.allocation_eligible', 1, $2::jsonb, $3) RETURNING id`,
      [checkoutId, JSON.stringify({ brandId: payloadBrandId, acceptedEventId: randomUUID(),
        acceptedSequence: 1, eligibilitySequence: 1, requestHash: 'a'.repeat(64),
        line: { checkoutLineId: randomUUID(), variantId: variant, locationId: location, quantity: 1 } }), `${tag}:checkout:${name}`],
    )).rows[0].id;
    checkoutEvents.push({ name, id: checkoutEvent });
  }
  const checkoutAuthWorker = new DurableWorker(pool, [{
    consumerId: checkoutConsumer,
    eventTypes: ['checkout.allocation_eligible'],
    authorization: { scope: 'brand', purpose: 'inventory.checkout_admission', effects: ['inventory.allocate'] },
    async handle(event, _transaction, context) {
      await context.authorizeEffect('inventory.allocate', event.eventPayload.brandId);
      effects.push(event.id);
    },
  }], {
    maxAttempts: 1,
    workerAuthorization: new DatabaseWorkerAuthorizationService(pool, {
      async authenticate() {
        return { id: workerPrincipalId, active: true, permittedConsumers: [checkoutConsumer], provenance: 'internal.service.port' };
      },
    }),
  });
  assert.equal(await checkoutAuthWorker.enqueueOutboxBatch(), 2);
  const checkoutAuthResult = await checkoutAuthWorker.runOnce(checkoutConsumer, `${tag}:checkout-auth`, 2);
  assert.equal(checkoutAuthResult.processed, 1);
  assert.equal(checkoutAuthResult.deadLetter, 1);
  assert.deepEqual(effects, [allowedEvent, checkoutEvents.find((item) => item.name === 'valid').id],
    'checkout worker brand is derived from the variant and active warehouse, and a spoofed payload brand is denied');
  const checkoutBindings = await pool.query(
    `SELECT brand_id FROM platform.worker_job_authorizations WHERE source_event_id = ANY($1::uuid[])`,
    [checkoutEvents.map((item) => item.id)],
  );
  assert.equal(checkoutBindings.rowCount, 2);
  assert.ok(checkoutBindings.rows.every((row) => row.brand_id === brandA));

  const revokedConsumer = 'ren2_51_revoked_worker';
  const effectsBeforeRevocationCheck = [...effects];
  let revokedPrincipalActive = true;
  const revokedEvent = (await pool.query(
    `INSERT INTO platform.outbox_events
       (aggregate_type, aggregate_id, event_type, event_version, event_payload, event_key)
     VALUES ('media_asset', $1, 'media.asset.revoked', 1, $2::jsonb, $3) RETURNING id`,
    [mediaAsset, JSON.stringify({ brandId: brandA }), `${tag}:revoked`],
  )).rows[0].id;
  const revokedAuthorization = new DatabaseWorkerAuthorizationService(pool, {
    async authenticate() {
      return { id: workerPrincipalId, active: revokedPrincipalActive, permittedConsumers: [revokedConsumer], provenance: 'internal.service.port' };
    },
  });
  const revokedWorker = new DurableWorker(pool, [{
    consumerId: revokedConsumer,
    eventTypes: ['media.asset.revoked'],
    authorization: { scope: 'brand', purpose: 'media.revoke.process', effects: ['media.revoke'] },
    async handle() { effects.push('revoked-effect'); },
  }], {
    maxAttempts: 1,
    workerAuthorization: revokedAuthorization,
  });
  assert.equal(await revokedWorker.enqueueOutboxBatch(), 1, 'the authorized job gets a durable target entitlement before delivery');
  revokedPrincipalActive = false;
  const revokedResult = await revokedWorker.runOnce(revokedConsumer, `${tag}:revoked-worker`, 1);
  assert.equal(revokedResult.deadLetter, 1);
  assert.deepEqual(effects, effectsBeforeRevocationCheck, 'revoked worker principal must not reach the handler');
  const revokedDecision = await pool.query(
    `SELECT decision, reason_code FROM platform.worker_authorization_audit
     WHERE source_event_id = $1`, [revokedEvent],
  );
  assert.deepEqual(revokedDecision.rows, [{ decision: 'denied', reason_code: 'PRINCIPAL_REVOKED' }]);
});
