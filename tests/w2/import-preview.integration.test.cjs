'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { ImportPreviewService } = require('../../dist/modules/imports/import-preview.service.js');
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

test('REN2-77 persists brand-scoped mapping revisions and preview snapshots with CAS and exact concurrent idempotent replay', {
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
  for (const permissionCode of ['imports.read', 'imports.write']) {
    const permission = (await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description)
      VALUES($1,'imports',$2,'REN2-77 integration permission')
      ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code RETURNING id`,
    [permissionCode, permissionCode.endsWith('.read') ? 'read' : 'write'])).rows[0].id;
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
  const taxonomy = new TaxonomyAdminPostgresRepository({ pool });
  const taxonomyRequest = `r77:${suffix}`;
  await taxonomy.propose({ categoryId: category, version: 1, validatorVersion: 'w2-attribute-validator-v1', ruleset: { attributes: [
    { attributeId: material.id, code: material.code, scope: 'product', valueType: 'text', requiredByDefault: false },
    { attributeId: color.id, code: color.code, scope: 'variant', valueType: 'enum', allowedValues: ['Blue','Red'], requiredByDefault: false },
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
  await pool.query(`INSERT INTO imports.import_rows(batch_id,brand_id,source_row_number,raw_record)
    VALUES($1,$2,2,$3::jsonb)`, [batch, brand, JSON.stringify({ Title: 'Synthetic shirt', Style: 'SYNTHETIC-77', SKU: `SKU-${suffix}`,
      Category: 'Tops', Material: 'Cotton', Color: 'Blue' })]);

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

  await assert.rejects(service.saveMapping({ ...request, mapping: { ...request.mapping, fieldMappings: { ...request.mapping.fieldMappings, Title: 'imageUrl' } } }),
    (error) => error?.status === 409 && error?.response?.code === 'IMPORT_IDEMPOTENCY_CONFLICT');
  await assert.rejects(service.saveMapping({ ...request, idempotencyKey: `stale-${suffix}`, expectedVersion: 0 }),
    (error) => error?.status === 409 && error?.response?.code === 'IMPORT_MAPPING_VERSION_STALE');
  await assert.rejects(service.getPreview({ brandId: randomUUID(), batchId: batch, userId: owner, requestId: `cross-${suffix}` }),
    (error) => error?.status === 404 && error?.response?.code === 'IMPORT_PREVIEW_NOT_FOUND');

  const effects = await pool.query(`SELECT count(*)::integer AS count FROM catalogue.products WHERE brand_id=$1`, [brand]);
  assert.equal(effects.rows[0].count, 0, 'a preview must not write or publish catalogue products');
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

  const nextMapping = { ...request.mapping, categoryMappings: { Shirt: 'missing-category' } };
  const next = await service.saveMapping({ ...request, idempotencyKey: `mapping-next-${suffix}`, expectedVersion: 1, mapping: nextMapping });
  assert.equal(next.mappingVersion, 2);
  assert.equal(next.previewRevision, 2);
  assert.notEqual(next.previewHash, first.previewHash);
  const staleProduct = (await pool.query(`INSERT INTO catalogue.products
    (brand_id,category_id,style_code,title,category_schema_version)
    VALUES($1,$2,$3,'Synthetic stale-check shirt',1) RETURNING id`, [brand, category, `STALE-${suffix.slice(0, 20)}`])).rows[0].id;
  await pool.query(`INSERT INTO catalogue.product_variants(brand_id,product_id,sku,option_signature,options)
    VALUES($1,$2,$3,'[]',jsonb_build_object($4::text,'Blue'))`, [brand, staleProduct, `SKU-${suffix}`, colorCode]);
  const staleRevision = await service.saveMapping({ ...request, idempotencyKey: `mapping-stale-preview-${suffix}`, expectedVersion: 2,
    mapping: request.mapping });
  assert.equal(staleRevision.mappingVersion, 3);
  await pool.query(`UPDATE catalogue.products SET row_version=row_version+1,content_version=content_version+1,updated_at=now()
    WHERE id=$1 AND brand_id=$2`, [staleProduct, brand]);
  await assert.rejects(service.getPreview({ brandId: brand, batchId: batch, userId: owner, requestId: `stale-read-${suffix}` }),
    (error) => error?.status === 409 && error?.response?.code === 'PREVIEW_STALE');
  const retained = await pool.query('SELECT preview_hash FROM imports.import_previews WHERE batch_id=$1 AND brand_id=$2 ORDER BY preview_revision', [batch, brand]);
  assert.deepEqual(retained.rows.map((row) => row.preview_hash.trim()), [first.previewHash, next.previewHash, staleRevision.previewHash], 'new mapping appends previews instead of rewriting old ones');
});
