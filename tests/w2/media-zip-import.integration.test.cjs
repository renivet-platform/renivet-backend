'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID, createHash } = require('node:crypto');
const { Pool } = require('pg');
const { DatabaseWorkerAuthorizationService } = require('../../dist/workers/worker-authorization.js');
const { MediaZipPostgresRepository } = require('../../dist/modules/media/media-zip.repository.js');

const databaseUrl = process.env.RENIVET_TEST_DATABASE_URL;
function disposableUrl() {
  assert.ok(databaseUrl, 'RENIVET_TEST_DATABASE_URL is required');
  const url = new URL(databaseUrl);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/renivet_ci');
  assert.equal(url.username, 'renivet_ci');
  return databaseUrl;
}

test('REN2-82 stores immutable SKU/variant mappings, brand-bound queued batches, and idempotent per-image audit receipts',
  { skip: !databaseUrl, timeout: 30_000 }, async (t) => {
    const pool = new Pool({ connectionString: disposableUrl(), max: 4, connectionTimeoutMillis: 5000 });
    t.after(() => pool.end());
    const suffix = randomUUID();
    const actor = (await pool.query(`INSERT INTO identity.users(email,display_name,state) VALUES($1,'REN2-82 test owner','active') RETURNING id`,
      [`ren2-82-${suffix}@example.invalid`])).rows[0].id;
    const brandId = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
      VALUES($1,'REN2-82 synthetic','REN2-82 synthetic','approved') RETURNING id`, [`ren2-82-${suffix}`])).rows[0].id;
    const foreignBrand = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
      VALUES($1,'REN2-82 foreign','REN2-82 foreign','approved') RETURNING id`, [`ren2-82-foreign-${suffix}`])).rows[0].id;
    const categoryId = (await pool.query(`INSERT INTO catalogue.categories(code,name) VALUES($1,'REN2-82 test') RETURNING id`, [`R82_${suffix.replaceAll('-','').slice(0,20)}`])).rows[0].id;
    await pool.query(`INSERT INTO catalogue.category_schema_versions(category_id,version,ruleset_sha256,validator_version)
      VALUES($1,1,repeat('a',64),'ren2-82-test')`, [categoryId]);
    const productId = (await pool.query(`INSERT INTO catalogue.products(brand_id,category_id,style_code,title,category_schema_version)
      VALUES($1,$2,$3,'REN2-82 test product',1) RETURNING id`, [brandId, categoryId, `R82-${suffix.slice(0,8)}`])).rows[0].id;
    const sku = `R82${suffix.replaceAll('-','').slice(0,12)}`;
    const variantId = (await pool.query(`INSERT INTO catalogue.product_variants(brand_id,product_id,sku,option_signature,options)
      VALUES($1,$2,$3,'default','{}'::jsonb) RETURNING id`, [brandId, productId, sku])).rows[0].id;
    const manifestId = randomUUID();
    const manifestHash = createHash('sha256').update(sku).digest('hex');
    await pool.query(`INSERT INTO media.zip_mapping_manifests(id,brand_id,created_by,idempotency_key,request_sha256,rights_attested)
      VALUES($1,$2,$3,$4,$5,true)`, [manifestId, brandId, actor, `r82-manifest-${suffix}`, manifestHash]);
    await pool.query(`INSERT INTO media.zip_mapping_manifest_items(manifest_id,brand_id,sku,product_id,variant_id)
      VALUES($1,$2,$3,$4,$5)`, [manifestId, brandId, sku, productId, variantId]);
    await assert.rejects(pool.query(`UPDATE media.zip_mapping_manifests SET rights_attested=false WHERE id=$1`, [manifestId]));
    await assert.rejects(pool.query(`INSERT INTO media.zip_mapping_manifest_items(manifest_id,brand_id,sku,product_id,variant_id)
      VALUES($1,$2,$3,$4,$5)`, [manifestId, brandId, sku.toLowerCase(), productId, variantId]));

    const uploadId = randomUUID();
    const sourceHash = createHash('sha256').update(`archive-${suffix}`).digest('hex');
    await pool.query(`INSERT INTO imports.import_uploads(id,brand_id,source_kind,file_name,mime_type,byte_length,source_sha256,storage_key,idempotency_key,created_by,expires_at)
      VALUES($1,$2,'MEDIA_ZIP','catalog-images.zip','application/zip',1024,$3,$4,$5,$6,now()+interval '5 minutes')`,
    [uploadId, brandId, sourceHash, `brands/${brandId}/imports/${uploadId}/source`, `r82-upload-${suffix}`, actor]);
    const batchId = randomUUID();
    const requestHash = createHash('sha256').update(`${uploadId}:${manifestId}`).digest('hex');
    await pool.query(`INSERT INTO media.zip_import_batches(id,brand_id,file_upload_id,source_kind,mapping_manifest_id,created_by,idempotency_key,request_sha256)
      VALUES($1,$2,$3,'MEDIA_ZIP',$4,$5,$6,$7)`, [batchId, brandId, uploadId, manifestId, actor, `r82-batch-${suffix}`, requestHash]);
    await pool.query(`UPDATE imports.import_uploads SET status='CONSUMED',consumed_at=now() WHERE id=$1`, [uploadId]);
    await pool.query(`INSERT INTO platform.outbox_events(aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
      VALUES('media.zip_import',$1,'media.zip_import.requested',1,$2::jsonb,$3)`,
    [batchId, JSON.stringify({ brandId, batchId }), `r82-outbox-${suffix}`]);
    const client = await pool.connect();
    try {
      const authorization = new DatabaseWorkerAuthorizationService(pool, { async authenticate() { throw new Error('not used by source lookup'); } });
      assert.equal(await authorization.resolveSourceBrand({ aggregateType: 'media.zip_import', aggregateId: batchId }, client), brandId);
      assert.equal(await authorization.resolveSourceBrand({ aggregateType: 'media.zip_import', aggregateId: randomUUID() }, client), null);
    } finally { client.release(); }
    const guarded = await pool.query(`SELECT id FROM media.zip_import_batches WHERE id=$1 AND brand_id=$2`, [batchId, foreignBrand]);
    assert.equal(guarded.rowCount, 0);

    const effectId = randomUUID();
    const effectKey = createHash('sha256').update(`${batchId}:${sku}:1`).digest('hex');
    const imageHash = createHash('sha256').update(`image-${suffix}`).digest('hex');
    await pool.query(`INSERT INTO media.zip_import_effects(id,batch_id,brand_id,product_id,variant_id,sku,slot,source_path,source_sha256,effect_key,state,error_code,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,'FAILED','MEDIA_MALWARE_REJECTED',now())`,
    [effectId, batchId, brandId, productId, variantId, sku, `${sku}__01.jpg`, imageHash, effectKey]);
    await pool.query(`INSERT INTO media.zip_import_audit_events(brand_id,batch_id,manifest_id,effect_id,actor_user_id,request_id,event_name,payload_sha256)
      VALUES($1,$2,$3,$4,$5,$6,'image_rejected',$7) ON CONFLICT(effect_id,event_name,payload_sha256) DO NOTHING`,
    [brandId, batchId, manifestId, effectId, actor, `r82-request-${suffix}`, imageHash]);
    await pool.query(`INSERT INTO media.zip_import_audit_events(brand_id,batch_id,manifest_id,effect_id,actor_user_id,request_id,event_name,payload_sha256)
      VALUES($1,$2,$3,$4,$5,$6,'image_rejected',$7) ON CONFLICT(effect_id,event_name,payload_sha256) DO NOTHING`,
    [brandId, batchId, manifestId, effectId, actor, `r82-request-${suffix}`, imageHash]);
    const audit = await pool.query(`SELECT id FROM media.zip_import_audit_events WHERE effect_id=$1 AND event_name='image_rejected'`, [effectId]);
    assert.equal(audit.rowCount, 1);
    const receipt = await pool.query(`SELECT state,source_sha256 FROM media.zip_import_effects WHERE id=$1 AND batch_id=$2`, [effectId, batchId]);
    assert.equal(receipt.rows[0].state, 'FAILED');
    assert.equal(receipt.rows[0].source_sha256.trim(), imageHash);

    const secondEffectId = randomUUID();
    const secondEffectKey = createHash('sha256').update(`${batchId}:${sku}:2`).digest('hex');
    const secondImageHash = createHash('sha256').update(`second-image-${suffix}`).digest('hex');
    await pool.query(`INSERT INTO media.zip_import_effects(id,batch_id,brand_id,product_id,variant_id,sku,slot,source_path,source_sha256,effect_key,state,error_code,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,2,$7,$8,$9,'FAILED','MEDIA_IMAGE_INVALID',now())`,
    [secondEffectId, batchId, brandId, productId, variantId, sku, `${sku}__02.jpg`, secondImageHash, secondEffectKey]);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM media.zip_import_effects WHERE batch_id=$1 AND variant_id=$2`, [batchId, variantId])).rows[0].count, 2);

    const remoteBatchId = randomUUID();
    const remoteHash = createHash('sha256').update(`remote-${suffix}`).digest('hex');
    await pool.query(`INSERT INTO media.zip_import_batches(id,brand_id,file_upload_id,source_kind,mapping_manifest_id,created_by,idempotency_key,request_sha256)
      VALUES($1,$2,NULL,'REMOTE_URL',$3,$4,$5,$6)`, [remoteBatchId, brandId, manifestId, actor, `r82-remote-${suffix}`, remoteHash]);
    const url1 = `https://cdn.example.test/${suffix}/one.jpg`;
    const url2 = `https://cdn.example.test/${suffix}/two.jpg`;
    await pool.query(`INSERT INTO media.zip_import_remote_items(batch_id,brand_id,mapping_manifest_id,sku,slot,source_url,source_url_sha256)
      VALUES($1,$2,$3,$4,1,$5,$6),($1,$2,$3,$4,2,$7,$8)`,
    [remoteBatchId, brandId, manifestId, sku, url1, createHash('sha256').update(url1).digest('hex'), url2, createHash('sha256').update(url2).digest('hex')]);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM media.zip_import_remote_items WHERE batch_id=$1', [remoteBatchId])).rows[0].count, 2);
    await assert.rejects(pool.query(`UPDATE media.zip_import_remote_items SET source_url='https://attacker.example/changed.jpg' WHERE batch_id=$1`, [remoteBatchId]));
    await assert.rejects(pool.query(`INSERT INTO media.zip_import_remote_items(batch_id,brand_id,mapping_manifest_id,sku,slot,source_url,source_url_sha256)
      VALUES($1,$2,$3,'FOREIGN_SKU',3,'https://cdn.example.test/foreign.jpg',$4)`,
    [remoteBatchId, brandId, manifestId, createHash('sha256').update('https://cdn.example.test/foreign.jpg').digest('hex')]));

    const assetId = randomUUID();
    const successfulHash = createHash('sha256').update(`successful-image-${suffix}`).digest('hex');
    const successfulKey = createHash('sha256').update(`successful-effect-${suffix}`).digest('hex');
    await pool.query(`INSERT INTO media.media_assets(id,brand_id,storage_key,sha256,mime_type,rights_state,rights_attested_by,rights_attested_at)
      VALUES($1,$2,$3,$4,'image/png','ATTESTED',$5,now())`,
    [assetId, brandId, `brands/${brandId}/test/${assetId}`, successfulHash, actor]);
    await pool.query(`INSERT INTO media.media_derivatives(brand_id,media_asset_id,derivative_kind,storage_key,sha256,mime_type,byte_length,width,height)
      VALUES($1,$2,'PREVIEW',$3,$4,'image/webp',1,1,1),($1,$2,'THUMBNAIL',$5,$6,'image/webp',1,1,1)`,
    [brandId, assetId, `brands/${brandId}/test/${assetId}/preview`, successfulHash, `brands/${brandId}/test/${assetId}/thumbnail`, successfulHash]);
    await pool.query(`UPDATE media.media_assets SET scan_state='CLEAN',derivative_state='READY',completed_at=now(),row_version=row_version+1 WHERE id=$1`, [assetId]);
    await pool.query(`INSERT INTO media.zip_import_effects(id,batch_id,brand_id,product_id,variant_id,media_asset_id,sku,slot,source_path,source_sha256,effect_key,state,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,3,$8,$9,$10,'SUCCEEDED',now())`,
    [randomUUID(), batchId, brandId, productId, variantId, assetId, sku, `${sku}__03.png`, successfulHash, successfulKey]);
    const repository = new MediaZipPostgresRepository({ pool }, {});
    await repository.markFailed(batchId, 'MEDIA_ZIP_IMAGE_INVALID');
    const partialBatch = await pool.query('SELECT state,failure_code FROM media.zip_import_batches WHERE id=$1', [batchId]);
    assert.equal(partialBatch.rows[0].state, 'PARTIAL');
    assert.equal(partialBatch.rows[0].failure_code, 'MEDIA_ZIP_IMAGE_INVALID');
  });
