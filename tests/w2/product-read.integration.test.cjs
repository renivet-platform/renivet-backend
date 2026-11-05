'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { BrandAccessGuard, REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');
const { BrandAccessRepository } = require('../../dist/modules/access/brand-access.repository.js');
const { IdentityRepository } = require('../../dist/modules/identity/identity.repository.js');
const { SessionService, hashSessionToken } = require('../../dist/modules/identity/session.service.js');
const { ProductReadPostgresRepository } = require('../../dist/modules/catalog/product-read.repository.js');
const { ProductReadService } = require('../../dist/modules/catalog/product-read.service.js');

const url = process.env.RENIVET_TEST_DATABASE_URL;
test('REN2-70 returns complete brand-scoped product pages and detail with ETag-ready version fields', {
  skip: !url && 'requires the disposable PostgreSQL 16 service', timeout: 60_000,
}, async (t) => {
  const parsed = new URL(url); assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.pathname, '/renivet_ci'); assert.equal(parsed.username, 'renivet_ci');
  const pool = new Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 5000 }); t.after(() => pool.end());
  const pgVersion = await pool.query('SHOW server_version_num'); assert.ok(+pgVersion.rows[0].server_version_num >= 160000 && +pgVersion.rows[0].server_version_num < 170000);
  const suffix = randomUUID().replaceAll('-', '');
  const addUser = async (name) => (await pool.query(`INSERT INTO identity.users(email,display_name,state) VALUES($1,$2,'active') RETURNING id`, [`r70-${name}-${suffix}@example.test`, name])).rows[0].id;
  const owner = await addUser('owner'), grantor = await addUser('grantor');
  const brandA = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state) VALUES($1,'REN2-70 A','REN2-70 A','approved') RETURNING id`, [`r70-a-${suffix}`])).rows[0].id;
  const brandB = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state) VALUES($1,'REN2-70 B','REN2-70 B','approved') RETURNING id`, [`r70-b-${suffix}`])).rows[0].id;
  await pool.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at) VALUES($1,$2,'active',$3,now())`, [brandA, owner, grantor]);
  const role = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system) VALUES($1,'brand','REN2-70 disposable role',false) RETURNING id`, [`r70_${suffix}`])).rows[0].id;
  const permission = (await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description) VALUES('catalog.read','catalog','read','REN2-70 read test') ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code RETURNING id`)).rows[0].id;
  await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [role, permission]);
  const assignment = (await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id) VALUES($1,$2,$3,'brand',now(),$4) RETURNING id`, [owner, role, brandA, grantor])).rows[0].id;
  const token = randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO identity.user_sessions(user_id,token_hash,expires_at,absolute_expires_at) VALUES($1,$2,now()+interval '30 minutes',now()+interval '1 day')`, [owner, hashSessionToken(token)]);
  const sessions = new SessionService(new IdentityRepository({ pool }), randomBytes(32).toString('hex'));
  const guard = new BrandAccessGuard({ get: (key) => key === REQUIRE_BRAND_PERMISSION ? 'catalog.read' : undefined }, sessions, new BrandAccessRepository({ pool }));
  const request = { headers: { cookie: `__Host-renivet_session=${token}` }, params: { brandId: brandA } };
  await guard.canActivate({ getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => request }) });
  const context = request.brandAccess;

  const category = (await pool.query(`INSERT INTO catalogue.categories(code,name) VALUES($1,$1) RETURNING id`, [`r70-cat-${suffix}`])).rows[0].id;
  const schemaVersion = (await pool.query(`INSERT INTO catalogue.category_schema_versions(category_id,version,state,ruleset,ruleset_sha256,validator_version) VALUES($1,1,'DRAFT','{}','${'a'.repeat(64)}','test') RETURNING id`, [category])).rows[0].id;
  const attr = (await pool.query(`INSERT INTO catalogue.attributes(code,label,value_type,scope_type) VALUES($1,'REN2-70 material','text','product') RETURNING id`, [`r70-material-${suffix}`])).rows[0].id;
  const rule = (await pool.query(`INSERT INTO catalogue.category_schema_attribute_rules(schema_version_id,attribute_id,attribute_code,scope_type,value_type) VALUES($1,$2,$3,'product','text') RETURNING id`, [schemaVersion, attr, `r70-material-${suffix}`])).rows[0].id;
  const productA = (await pool.query(`INSERT INTO catalogue.products(brand_id,category_id,style_code,title,category_schema_version) VALUES($1,$2,'R70-A','Complete product',1) RETURNING id`, [brandA, category])).rows[0].id;
  await pool.query(`INSERT INTO catalogue.products(brand_id,category_id,style_code,title,category_schema_version) VALUES($1,$2,'R70-A2','Second brand A product',1)`, [brandA, category]);
  const productB = (await pool.query(`INSERT INTO catalogue.products(brand_id,category_id,style_code,title,category_schema_version) VALUES($1,$2,'R70-B','Other brand product',1) RETURNING id`, [brandB, category])).rows[0].id;
  await pool.query(`INSERT INTO catalogue.product_attribute_values(brand_id,product_id,category_id,category_schema_version,attribute_id,schema_version_id,frozen_rule_id,val_text) VALUES($1,$2,$3,1,$4,$5,$6,'organic cotton')`, [brandA, productA, category, attr, schemaVersion, rule]);
  await pool.query(`INSERT INTO catalogue.product_revisions(brand_id,product_id,content_version,content_snapshot,content_sha256,submitted_by,review_state,category_id,category_schema_version)
    VALUES($1,$2,1,'{}',repeat('a',64),$3,'APPROVED',$4,1),($1,$2,2,'{}',repeat('b',64),$3,'DRAFT',$4,1),($1,$2,3,'{}',repeat('c',64),$3,'REJECTED',$4,1)`, [brandA, productA, owner, category]);
  await pool.query(`UPDATE catalogue.products SET content_version=3 WHERE id=$1`, [productA]);
  const variantIds = [];
  for (let i = 0; i < 6; i++) variantIds.push((await pool.query(`INSERT INTO catalogue.product_variants(brand_id,product_id,sku,option_signature,options) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id`, [brandA, productA, `R70-${i}`, `size-${i}`, JSON.stringify({ size: `S${i}` })])).rows[0].id);
  await pool.query(`INSERT INTO catalogue.variant_prices(brand_id,variant_id,amount_minor,mrp_minor,valid_from,price_state,rule_version) VALUES($1,$2,1000,1200,now(),'DRAFT',1),($1,$2,1100,1300,now()+interval '1 hour','PENDING',1)`, [brandA, variantIds[0]]);
  const assets = [];
  for (let i = 0; i < 3; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const asset = (await client.query(`INSERT INTO media.media_assets(brand_id,storage_key,sha256,mime_type,scan_state,rights_state,derivative_state) VALUES($1,$2,$3,'image/jpeg','PENDING','ATTESTED','PENDING') RETURNING id`, [brandA, `r70/${suffix}/${i}`, String(i).padStart(64, '0')])).rows[0].id;
      for (const kind of ['PREVIEW','THUMBNAIL']) await client.query(`INSERT INTO media.media_derivatives(brand_id,media_asset_id,derivative_kind,storage_key,sha256,mime_type,byte_length,width,height) VALUES($1,$2,$3,$4,$5,'image/webp',1,1,1)`, [brandA, asset, kind, `r70/${suffix}/${i}/${kind}`, String(i + kind.length).padStart(64, '0')]);
      await client.query(`UPDATE media.media_assets SET scan_state='CLEAN',derivative_state='READY',completed_at=now(),row_version=row_version+1 WHERE id=$1`, [asset]);
      await client.query('COMMIT'); assets.push(asset);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  for (let i = 0; i < assets.length; i++) await pool.query(`INSERT INTO media.product_media(brand_id,product_id,media_asset_id,display_role,display_order) VALUES($1,$2,$3,'GALLERY',$4)`, [brandA, productA, assets[i], i]);

  const repository = new ProductReadPostgresRepository({ pool });
  const first = await repository.list(context, { cursor: null, limit: 1, categoryId: null, reviewState: null, visibility: null });
  assert.equal(first.totalCount, 2, 'brand B products do not inflate count'); assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  const all = await repository.list(context, { cursor: null, limit: 25, categoryId: null, reviewState: null, visibility: 'PRIVATE' });
  assert.equal(all.totalCount, 2); assert.equal(all.items.every((item) => item.brandId === brandA), true);
  assert.equal((await repository.list(context, { cursor: null, limit: 25, categoryId: null, reviewState: 'APPROVED', visibility: null })).totalCount, 0,
    'an earlier approved revision does not override the current rejected revision');
  assert.equal((await repository.list(context, { cursor: null, limit: 25, categoryId: null, reviewState: 'REJECTED', visibility: null })).totalCount, 1);
  const detail = await repository.get(context, productA);
  assert.equal(detail.rowVersion, 1); assert.equal(detail.variants.length, 6); assert.equal(detail.mediaLinks.length, 3);
  assert.equal(detail.draftRevisionId, null, 'an older draft revision is not reported as the current draft');
  assert.equal(detail.attributes[`r70-material-${suffix}`], 'organic cotton');
  const versionedVariant = detail.variants.find((variant) => variant.priceVersions.length === 2);
  assert.ok(versionedVariant); assert.deepEqual(versionedVariant.priceVersions.map((price) => price.priceState).sort(), ['DRAFT','PENDING']);
  assert.equal(Object.hasOwn(detail, 'claims'), false); assert.equal(Object.hasOwn(detail, 'evidence'), false);
  await assert.rejects(repository.get(context, productB), (error) => error.code === 'PRODUCT_NOT_FOUND');
  await assert.rejects(repository.list(context, { cursor: first.nextCursor, limit: 1, categoryId: category, reviewState: null, visibility: null }), (error) => error.code === 'PRODUCT_CURSOR_INVALID');
  const filterHash = createHash('sha256').update(JSON.stringify([brandA, null, null, null])).digest('hex');
  for (const updatedAt of ['2026-02-31T00:00:00.000000Z', '0000-01-01T00:00:00.000000Z']) {
    const invalidTimestampCursor = Buffer.from(JSON.stringify({ updatedAt, id: productA, filterHash })).toString('base64url');
    await assert.rejects(new ProductReadService(repository).list(context, { cursor: invalidTimestampCursor }), (error) => error.getStatus?.() === 400);
  }
  await pool.query('DELETE FROM access.role_assignments WHERE id=$1', [assignment]);
  await assert.rejects(repository.list(context, { cursor: null, limit: 25, categoryId: null, reviewState: null, visibility: null }), (error) => error.code === 'PRODUCT_READ_FORBIDDEN');
});
