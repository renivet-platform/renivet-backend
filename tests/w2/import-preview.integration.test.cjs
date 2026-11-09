'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { ImportPreviewService } = require('../../dist/modules/imports/import-preview.service.js');
const { ImportConfirmationService } = require('../../dist/modules/imports/import-confirmation.service.js');
const { ProductDraftPostgresRepository } = require('../../dist/modules/catalog/product-draft.repository.js');
const { ProductMediaPostgresRepository } = require('../../dist/modules/media/product-media.repository.js');
const { TaxonomyAdminPostgresRepository } = require('../../dist/modules/catalog/taxonomy-admin.repository.js');

const url = process.env.RENIVET_TEST_DATABASE_URL;
function assertDisposable(value) {
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required for REN2-77 PostgreSQL 16 integration tests');
  const parsed = new URL(value);
  assert.equal(parsed.protocol, 'postgresql:');
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, '/renivet_ci');
  assert.equal(parsed.username, 'renivet_ci');
}

test('REN2-77/78 persist immutable previews and atomically confirm per-target effects with CAS and exact replay', {
  skip: !url && 'requires the disposable PostgreSQL 16 database', timeout: 60_000,
}, async (t) => {
  assertDisposable(url);
  const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5_000 });
  t.after(() => pool.end());
  const serverVersion = await pool.query('SHOW server_version_num');
  assert.ok(Number(serverVersion.rows[0].server_version_num) >= 160000 && Number(serverVersion.rows[0].server_version_num) < 170000,
    'REN2-77 integration requires disposable PostgreSQL 16');

  const suffix = randomUUID().replaceAll('-', '');
  const owner = (await pool.query(`INSERT INTO identity.users(email,display_name,state)
    VALUES($1,'REN2-77 owner','active') RETURNING id`, [`ren2-77-${suffix}@example.invalid`])).rows[0].id;
  const grantor = (await pool.query(`INSERT INTO identity.users(email,display_name,state)
    VALUES($1,'REN2-77 grantor','active') RETURNING id`, [`ren2-77-grantor-${suffix}@example.invalid`])).rows[0].id;
  const brand = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
    VALUES($1,'REN2-77 synthetic','REN2-77 synthetic','approved') RETURNING id`, [`ren2-77-${suffix}`])).rows[0].id;
  await pool.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at)
    VALUES($1,$2,'active',$3,now())`, [brand, owner, grantor]);
  const role = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
    VALUES($1,'brand','REN2-77 disposable imports role',false) RETURNING id`, [`ren2_77_${suffix}`])).rows[0].id;
  for (const permissionCode of ['imports.read', 'imports.write', 'imports.confirm', 'catalog.write']) {
    const action = permissionCode.slice(permissionCode.indexOf('.') + 1);
    const permission = (await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description)
      VALUES($1,'imports',$2,'REN2-77 integration permission')
      ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code RETURNING id`,
    [permissionCode, action])).rows[0].id;
    await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [role, permission]);
  }
  await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
    VALUES($1,$2,$3,'brand',now(),$4)`, [owner, role, brand, grantor]);

  const categoryCode = `r77-${suffix.slice(0, 18)}`;
  const category = (await pool.query(`INSERT INTO catalogue.categories(code,name,active) VALUES($1,'REN2-77 synthetic category',false) RETURNING id`, [categoryCode])).rows[0].id;
  const materialCode = `r77_material_${suffix.slice(0, 12)}`;
  const colorCode = `r77_color_${suffix.slice(0, 12)}`;
  const material = (await pool.query(`INSERT INTO catalogue.attributes(code,label,value_type,scope_type)
    VALUES($1,'Synthetic material','text','product') RETURNING id,code`, [materialCode])).rows[0];
  const color = (await pool.query(`INSERT INTO catalogue.attributes(code,label,value_type,scope_type,allowed_values)
    VALUES($1,'Synthetic color','enum','variant','["Blue","Red"]'::jsonb) RETURNING id,code`, [colorCode])).rows[0];
  const sizeCode = `r77_size_${suffix.slice(0, 12)}`;
  const size = (await pool.query(`INSERT INTO catalogue.attributes(code,label,value_type,scope_type,allowed_values)
    VALUES($1,'Synthetic size','enum','variant','["S","M","L","XL"]'::jsonb) RETURNING id,code`, [sizeCode])).rows[0];
  const taxonomy = new TaxonomyAdminPostgresRepository({ pool });
  const taxonomyRequest = `r77:${suffix}`;
  await taxonomy.propose({ categoryId: category, version: 1, validatorVersion: 'w2-attribute-validator-v1', ruleset: { attributes: [
    { attributeId: material.id, code: material.code, scope: 'product', valueType: 'text', requiredByDefault: false },
    { attributeId: color.id, code: color.code, scope: 'variant', valueType: 'enum', allowedValues: ['Blue','Red'], requiredByDefault: false },
    { attributeId: size.id, code: size.code, scope: 'variant', valueType: 'enum', allowedValues: ['S','M','L','XL'], requiredByDefault: false },
  ] } }, { actorId: owner, requestId: taxonomyRequest, idempotencyKey: `r77-taxonomy-propose-${suffix}` });
  await taxonomy.publish({ categoryId: category, version: 1 }, { actorId: grantor, requestId: taxonomyRequest, idempotencyKey: `r77-taxonomy-publish-${suffix}` });
  const activation = await pool.connect();
  try {
    await activation.query('BEGIN');
    await activation.query(`SELECT set_config('app.taxonomy_actor_user_id',$1,true),set_config('app.taxonomy_request_id',$2,true),
      set_config('app.taxonomy_reason_code','INITIAL_ACTIVATION',true)`, [grantor, taxonomyRequest]);
    await activation.query('UPDATE catalogue.categories SET active=true WHERE id=$1', [category]);
    await activation.query('COMMIT');
  } catch (error) { await activation.query('ROLLBACK'); throw error; } finally { activation.release(); }

  const batch = (await pool.query(`INSERT INTO imports.import_batches
    (brand_id,source_kind,source_sha256,raw_storage_key,schema_version,source_as_of,job_state,requested_policy,created_by)
    VALUES($1,'GENERIC_CSV',$2,$3,'REN2-77-test',now(),'RECEIVED','{"mode":"CREATE_ONLY"}'::jsonb,$4) RETURNING id`,
  [brand, 'a'.repeat(64), `synthetic/${suffix}.csv`, owner])).rows[0].id;
  const mediaIds = [];
  for (const index of [1, 2, 3]) {
    const id = randomUUID(); mediaIds.push(id);
    const mediaClient = await pool.connect();
    try {
      await mediaClient.query('BEGIN');
      await mediaClient.query(`INSERT INTO media.media_assets
        (id,brand_id,storage_key,sha256,mime_type,width,height,scan_state,rights_state,derivative_state,file_name,byte_length,
         completed_at,rights_attested_by,rights_attested_at)
        VALUES($1,$2,$3,$4,'image/webp',800,800,'CLEAN','ATTESTED','READY',$5,32,now(),$6,now())`,
      [id, brand, `ren2-78/${suffix}/${index}/${id}`, `${String(index).repeat(64).slice(0,64)}`, `image-${index}.webp`, owner]);
      for (const kind of ['PREVIEW','THUMBNAIL']) await mediaClient.query(`INSERT INTO media.media_derivatives
        (brand_id,media_asset_id,derivative_kind,storage_key,sha256,mime_type,byte_length,width,height)
        VALUES($1,$2,$3,$4,$5,'image/webp',16,400,400)`, [brand, id, kind, `ren2-78/${id}/${kind.toLowerCase()}`, 'b'.repeat(64)]);
      await mediaClient.query('COMMIT');
    } catch (error) { await mediaClient.query('ROLLBACK'); throw error; } finally { mediaClient.release(); }
  }
  const importVariants = ['S','M','L','XL'].map((value, index) => ({ sku: `SKU-${suffix}-${value}`, options: { [colorCode]: index % 2 ? 'Red' : 'Blue', [sizeCode]: value } }));
  const importMedia = mediaIds.map((mediaAssetId, index) => ({ mediaAssetId, displayRole: 'GALLERY', displayOrder: index }));
  await pool.query(`INSERT INTO imports.import_rows(batch_id,brand_id,source_row_number,raw_record,canonical_record)
    VALUES($1,$2,2,$3::jsonb,$4::jsonb)`, [batch, brand, JSON.stringify({ Title: 'Synthetic shirt', Style: 'SYNTHETIC-77', SKU: `SKU-${suffix}`,
      Category: 'Tops', Material: 'Cotton', Color: 'Blue' }), JSON.stringify({ variants: importVariants, mediaAssets: importMedia })]);

  const service = new ImportPreviewService({ pool });
  const request = { brandId: brand, batchId: batch, actorUserId: owner, idempotencyKey: `mapping-${suffix}`,
    expectedVersion: 0, requestId: `ren2-77-${suffix}`, mapping: { fieldMappings: { Title: 'title', Style: 'styleCode', SKU: 'sku',
      Category: 'categoryCode', Material: `attributes.${materialCode}`, Color: `options.${colorCode}` }, categoryMappings: { Tops: categoryCode } } };
  const [first, concurrentReplay] = await Promise.all([service.saveMapping(request), service.saveMapping(request)]);
  assert.deepEqual(concurrentReplay, first, 'concurrent exact retries return the committed receipt');
  assert.equal(first.mappingVersion, 1);
  assert.equal(first.previewRevision, 1);
  const preview = await service.getPreview({ brandId: brand, batchId: batch, userId: owner, requestId: `read-${suffix}` });
  assert.equal(preview.previewRevision, 1);
  assert.equal(preview.previewHash, first.previewHash);
  assert.equal(preview.counts.create, 1);
  assert.equal(preview.rows[0].action, 'CREATE');
  assert.equal(preview.rows[0].proposed.variants.length, 4, 'the frozen row carries all four canonical variants');
  assert.equal(preview.rows[0].proposed.mediaAssets.length, 3, 'the frozen row carries all three approved media asset references');

  await assert.rejects(service.saveMapping({ ...request, mapping: { ...request.mapping, fieldMappings: { ...request.mapping.fieldMappings, Title: 'imageUrl' } } }),
    (error) => error?.status === 409 && error?.response?.code === 'IMPORT_IDEMPOTENCY_CONFLICT');
  await assert.rejects(service.saveMapping({ ...request, idempotencyKey: `stale-${suffix}`, expectedVersion: 0 }),
    (error) => error?.status === 409 && error?.response?.code === 'IMPORT_MAPPING_VERSION_STALE');
  await assert.rejects(service.getPreview({ brandId: randomUUID(), batchId: batch, userId: owner, requestId: `cross-${suffix}` }),
    (error) => error?.status === 404 && error?.response?.code === 'IMPORT_PREVIEW_NOT_FOUND');

  const effects = await pool.query(`SELECT count(*)::integer AS count FROM catalogue.products WHERE brand_id=$1`, [brand]);
  assert.equal(effects.rows[0].count, 0, 'a preview must not write or publish catalogue products');
  const confirmation = new ImportConfirmationService({ pool }, new ProductDraftPostgresRepository({ pool }), new ProductMediaPostgresRepository({ pool }));
  const confirmationInput = { brandId: brand, batchId: batch, actorUserId: owner, idempotencyKey: `confirm-${suffix}`,
    previewRevision: first.previewRevision, previewHash: first.previewHash, allowPartial: false, requestId: `confirm-request-${suffix}` };
  const [confirmed, concurrentConfirmationReplay] = await Promise.all([confirmation.confirm(confirmationInput), confirmation.confirm(confirmationInput)]);
  assert.equal(confirmed.state, 'COMPLETED');
  assert.equal(confirmed.effectsApplied, 7, 'four variants and three image links each have their own receipt');
  assert.deepEqual(concurrentConfirmationReplay, confirmed, 'concurrent exact confirmation retries return the same saved receipt');
  assert.deepEqual(await confirmation.confirm(confirmationInput), confirmed, 'exact replay returns its immutable result');
  await assert.rejects(confirmation.confirm({ ...confirmationInput, allowPartial: true }),
    (error) => error?.status === 409 && error?.response?.code === 'IMPORT_IDEMPOTENCY_CONFLICT');
  await assert.rejects(confirmation.confirm({ ...confirmationInput, brandId: randomUUID(), idempotencyKey: `foreign-${suffix}` }),
    (error) => error?.status === 404 && error?.response?.code === 'IMPORT_BATCH_NOT_FOUND');
  const receipts = await pool.query(`SELECT effect_kind,count(*)::integer AS count FROM imports.import_effect_receipts
    WHERE batch_id=$1 AND brand_id=$2 GROUP BY effect_kind ORDER BY effect_kind`, [batch, brand]);
  assert.deepEqual(Object.fromEntries(receipts.rows.map((row) => [row.effect_kind, row.count])), { MEDIA_LINK: 3, VARIANT_UPSERT: 4 });
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM media.product_media WHERE brand_id=$1', [brand])).rows[0].count, 3);
  const confirmationRow = await pool.query('SELECT id FROM imports.import_confirmations WHERE id=$1 AND brand_id=$2', [confirmed.confirmationId, brand]);
  await assert.rejects(pool.query(`UPDATE imports.import_confirmations SET response_payload='{}'::jsonb WHERE id=$1`, [confirmationRow.rows[0].id]), /IMMUTABLE_RECORD/);
  await assert.rejects(pool.query(`UPDATE imports.import_effect_receipts SET outcome='FAILED' WHERE batch_id=$1 AND brand_id=$2`, [batch, brand]), /IMMUTABLE_RECORD/);

  const failedBatch = (await pool.query(`INSERT INTO imports.import_batches
    (brand_id,source_kind,source_sha256,raw_storage_key,schema_version,source_as_of,job_state,requested_policy,created_by)
    VALUES($1,'GENERIC_CSV',$2,$3,'REN2-78-test',now(),'RECEIVED','{"mode":"CREATE_ONLY"}'::jsonb,$4) RETURNING id`,
  [brand, 'c'.repeat(64), `synthetic/${suffix}-failed.csv`, owner])).rows[0].id;
  const failedSku = `FAIL-${suffix}`;
  await pool.query(`INSERT INTO imports.import_rows(batch_id,brand_id,source_row_number,raw_record,canonical_record)
    VALUES($1,$2,2,$3::jsonb,$4::jsonb)`, [failedBatch, brand, JSON.stringify({ Title: 'Atomic failure', Style: `FAIL-${suffix}`, SKU: failedSku,
      Category: 'Tops', Material: 'Cotton', Color: 'Blue' }), JSON.stringify({ variants: [{ sku: failedSku, options: { [colorCode]: 'Blue', [sizeCode]: 'S' } }],
      mediaAssets: [{ mediaAssetId: randomUUID(), displayRole: 'GALLERY', displayOrder: 0 }] })]);
  const failedPreview = await service.saveMapping({ ...request, batchId: failedBatch, idempotencyKey: `failed-map-${suffix}`, expectedVersion: 0 });
  await assert.rejects(confirmation.confirm({ ...confirmationInput, batchId: failedBatch, idempotencyKey: `failed-confirm-${suffix}`,
    previewRevision: failedPreview.previewRevision, previewHash: failedPreview.previewHash }),
    (error) => error?.status === 422);
  assert.equal(Number((await pool.query('SELECT count(*)::integer AS count FROM catalogue.product_variants WHERE brand_id=$1 AND sku=$2', [brand, failedSku])).rows[0].count), 0,
    'an invalid media target rolls back the preceding draft and variant effects when partial success is disabled');
  assert.equal(Number((await pool.query('SELECT count(*)::integer AS count FROM imports.import_effect_receipts WHERE batch_id=$1 AND brand_id=$2', [failedBatch, brand])).rows[0].count), 0);

  const partialBatch = (await pool.query(`INSERT INTO imports.import_batches
    (brand_id,source_kind,source_sha256,raw_storage_key,schema_version,source_as_of,job_state,requested_policy,created_by)
    VALUES($1,'GENERIC_CSV',$2,$3,'REN2-78-test',now(),'RECEIVED','{"mode":"CREATE_ONLY"}'::jsonb,$4) RETURNING id`,
  [brand, 'd'.repeat(64), `synthetic/${suffix}-partial.csv`, owner])).rows[0].id;
  const partialSku = `PART-${suffix}`;
  const partialVariants = ['S','M','L','XL'].map((value) => ({ sku: `${partialSku}-${value}`, options: { [colorCode]: 'Blue', [sizeCode]: value } }));
  const partialAssets = [{ mediaAssetId: mediaIds[0], displayRole: 'GALLERY', displayOrder: 0 },
    { mediaAssetId: randomUUID(), displayRole: 'GALLERY', displayOrder: 1 },
    { mediaAssetId: mediaIds[2], displayRole: 'GALLERY', displayOrder: 1 }];
  await pool.query(`INSERT INTO imports.import_rows(batch_id,brand_id,source_row_number,raw_record,canonical_record)
    VALUES($1,$2,2,$3::jsonb,$4::jsonb)`, [partialBatch, brand, JSON.stringify({ Title: 'Partial shirt', Style: partialSku, SKU: partialSku,
      Category: 'Tops', Material: 'Cotton', Color: 'Blue' }), JSON.stringify({ variants: partialVariants, mediaAssets: partialAssets })]);
  const partialPreview = await service.saveMapping({ ...request, batchId: partialBatch, idempotencyKey: `partial-map-${suffix}`, expectedVersion: 0 });
  const partialResult = await confirmation.confirm({ ...confirmationInput, batchId: partialBatch, idempotencyKey: `partial-confirm-${suffix}`,
    previewRevision: partialPreview.previewRevision, previewHash: partialPreview.previewHash, allowPartial: true });
  assert.equal(partialResult.state, 'PARTIAL');
  assert.equal(partialResult.failedRows, 1);
  assert.equal(partialResult.effectsApplied, 6, 'successful variants and two approved media links remain committed around one failed media target');
  assert.deepEqual(partialResult.failed.map((failure) => failure.code), ['PRODUCT_MEDIA_NOT_FOUND'], 'failure results expose only a stable domain code');
  assert.equal(Number((await pool.query('SELECT count(*)::integer AS count FROM imports.import_effect_receipts WHERE batch_id=$1 AND brand_id=$2', [partialBatch, brand])).rows[0].count), 6);
  const mappingRows = await pool.query('SELECT count(*)::integer AS count FROM imports.import_mapping_profiles WHERE batch_id=$1 AND brand_id=$2', [batch, brand]);
  assert.equal(mappingRows.rows[0].count, 1, 'concurrent replay stores exactly one immutable mapping revision');
  const profile = await pool.query('SELECT id,preview_revision,preview_hash FROM imports.import_mapping_profiles WHERE batch_id=$1 AND brand_id=$2', [batch, brand]);
  assert.equal(Number(profile.rows[0].preview_revision), first.previewRevision);
  assert.equal(profile.rows[0].preview_hash.trim(), first.previewHash);
  await assert.rejects(pool.query('UPDATE imports.import_mapping_profiles SET profile=\'{}\'::jsonb WHERE id=$1', [profile.rows[0].id]), /IMMUTABLE_RECORD/);
  const previewRow = await pool.query('SELECT id FROM imports.import_previews WHERE batch_id=$1 AND brand_id=$2', [batch, brand]);
  await assert.rejects(pool.query('UPDATE imports.import_previews SET preview_snapshot=\'{}\'::jsonb WHERE id=$1', [previewRow.rows[0].id]), /IMMUTABLE_RECORD/);
  const audit = await pool.query(`SELECT action,count(*)::integer AS count FROM access.security_audit_events
    WHERE actor_user_id=$1 AND subject_id=$2 AND action IN ('imports.mapping.saved','imports.preview.read') GROUP BY action`, [owner, batch]);
  assert.deepEqual(Object.fromEntries(audit.rows.map((row) => [row.action, row.count])), { 'imports.mapping.saved': 1, 'imports.preview.read': 1 });

  const staleBatch = (await pool.query(`INSERT INTO imports.import_batches
    (brand_id,source_kind,source_sha256,raw_storage_key,schema_version,source_as_of,job_state,requested_policy,created_by)
    VALUES($1,'GENERIC_CSV',$2,$3,'REN2-78-test',now(),'RECEIVED','{"mode":"CREATE_ONLY"}'::jsonb,$4) RETURNING id`,
  [brand, 'e'.repeat(64), `synthetic/${suffix}-stale.csv`, owner])).rows[0].id;
  await pool.query(`INSERT INTO imports.import_rows(batch_id,brand_id,source_row_number,raw_record)
    VALUES($1,$2,2,$3::jsonb)`, [staleBatch, brand, JSON.stringify({ Title: 'Synthetic stale-check shirt', Style: `STALE-${suffix.slice(0, 20)}`,
      SKU: `SKU-${suffix}`, Category: 'Tops', Material: 'Cotton', Color: 'Blue' })]);
  const staleRequest = { ...request, batchId: staleBatch };
  const nextMapping = { ...request.mapping, categoryMappings: { Shirt: 'missing-category' } };
  const next = await service.saveMapping({ ...staleRequest, idempotencyKey: `mapping-next-${suffix}`, expectedVersion: 0, mapping: nextMapping });
  assert.equal(next.mappingVersion, 1);
  assert.equal(next.previewRevision, 1);
  const staleProduct = (await pool.query(`INSERT INTO catalogue.products
    (brand_id,category_id,style_code,title,category_schema_version)
    VALUES($1,$2,$3,'Synthetic stale-check shirt',1) RETURNING id`, [brand, category, `STALE-${suffix.slice(0, 20)}`])).rows[0].id;
  await pool.query(`INSERT INTO catalogue.product_variants(brand_id,product_id,sku,option_signature,options)
    VALUES($1,$2,$3,'[]',jsonb_build_object($4::text,'Blue'))`, [brand, staleProduct, `SKU-${suffix}`, colorCode]);
  const staleRevision = await service.saveMapping({ ...staleRequest, idempotencyKey: `mapping-stale-preview-${suffix}`, expectedVersion: 1,
    mapping: request.mapping });
  assert.equal(staleRevision.mappingVersion, 2);
  await pool.query(`UPDATE catalogue.products SET row_version=row_version+1,content_version=content_version+1,updated_at=now()
    WHERE id=$1 AND brand_id=$2`, [staleProduct, brand]);
  await assert.rejects(service.getPreview({ brandId: brand, batchId: staleBatch, userId: owner, requestId: `stale-read-${suffix}` }),
    (error) => error?.status === 409 && error?.response?.code === 'PREVIEW_STALE');
  const effectsBeforeStaleConfirm = Number((await pool.query('SELECT count(*)::integer AS count FROM imports.import_effect_receipts WHERE batch_id=$1 AND brand_id=$2', [staleBatch, brand])).rows[0].count);
  await assert.rejects(confirmation.confirm({ ...confirmationInput, batchId: staleBatch, idempotencyKey: `stale-confirm-${suffix}`,
    previewRevision: staleRevision.previewRevision, previewHash: staleRevision.previewHash }),
    (error) => error?.status === 409 && error?.response?.code === 'PREVIEW_STALE');
  assert.equal(Number((await pool.query('SELECT count(*)::integer AS count FROM imports.import_effect_receipts WHERE batch_id=$1 AND brand_id=$2', [staleBatch, brand])).rows[0].count),
    effectsBeforeStaleConfirm, 'stale target CAS is rejected before applying any additional effects');
  const retained = await pool.query('SELECT preview_hash FROM imports.import_previews WHERE batch_id=$1 AND brand_id=$2 ORDER BY preview_revision', [staleBatch, brand]);
  assert.deepEqual(retained.rows.map((row) => row.preview_hash.trim()), [next.previewHash, staleRevision.previewHash], 'new mapping appends previews instead of rewriting old ones');

  const taxonomyBatch = (await pool.query(`INSERT INTO imports.import_batches
    (brand_id,source_kind,source_sha256,raw_storage_key,schema_version,source_as_of,job_state,requested_policy,created_by)
    VALUES($1,'GENERIC_CSV',$2,$3,'REN2-78-test',now(),'RECEIVED','{"mode":"CREATE_ONLY"}'::jsonb,$4) RETURNING id`,
  [brand, 'f'.repeat(64), `synthetic/${suffix}-taxonomy.csv`, owner])).rows[0].id;
  const taxonomySku = `TAX-${suffix}`;
  await pool.query(`INSERT INTO imports.import_rows(batch_id,brand_id,source_row_number,raw_record)
    VALUES($1,$2,2,$3::jsonb)`, [taxonomyBatch, brand, JSON.stringify({ Title: 'Taxonomy stale shirt', Style: taxonomySku, SKU: taxonomySku,
      Category: 'Tops', Material: 'Cotton', Color: 'Blue' })]);
  const taxonomyPreview = await service.saveMapping({ ...request, batchId: taxonomyBatch, idempotencyKey: `taxonomy-map-${suffix}`, expectedVersion: 0 });
  await pool.query(`INSERT INTO catalogue.categories(code,name,active) VALUES($1,'REN2-78 taxonomy mutation',false)`, [`new-${suffix.slice(0, 20)}`]);
  await assert.rejects(confirmation.confirm({ ...confirmationInput, batchId: taxonomyBatch, idempotencyKey: `taxonomy-confirm-${suffix}`,
    previewRevision: taxonomyPreview.previewRevision, previewHash: taxonomyPreview.previewHash }),
    (error) => error?.status === 409 && error?.response?.code === 'PREVIEW_STALE');
  assert.equal(Number((await pool.query('SELECT count(*)::integer AS count FROM imports.import_effect_receipts WHERE batch_id=$1 AND brand_id=$2', [taxonomyBatch, brand])).rows[0].count), 0,
    'taxonomy CAS is checked before creating a product or writing any effect receipt');
});
