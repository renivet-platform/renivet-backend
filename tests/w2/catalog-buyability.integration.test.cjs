'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { CatalogReviewPostgresRepository } = require('../../dist/modules/catalog/catalog-review.repository.js');
const { CatalogPublicationPostgresRepository } = require('../../dist/modules/catalog/catalog-publication.repository.js');
const { CatalogBuyabilityPostgresPort } = require('../../dist/modules/catalog/catalog-buyability.js');
const { snapshotSha256 } = require('../../dist/modules/catalog/catalog-submission.js');

const dbUrl = process.env.RENIVET_TEST_DATABASE_URL;

test('REN2-75 rechecks PostgreSQL publication, SKU and effective price inside a synthetic checkout transaction', {
  skip: !dbUrl && 'requires disposable PostgreSQL 16', timeout: 90_000,
}, async (t) => {
  const parsed = new URL(dbUrl);
  assert.equal(parsed.protocol, 'postgresql:'); assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.username, 'renivet_ci'); assert.equal(parsed.pathname, '/renivet_ci');
  const source = new Pool({ connectionString: dbUrl, max: 1 });
  const serverVersion = Number((await source.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(serverVersion >= 160000 && serverVersion < 170000);
  await source.end();
  const suffix = randomUUID().replaceAll('-', ''); const database = `ren2_75_${suffix}`;
  const adminUrl = new URL(dbUrl); adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  assert.equal((await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]?.rolsuper, true);
  await admin.query(`CREATE DATABASE ${database} TEMPLATE renivet_ci`); await admin.end();
  const isolatedUrl = new URL(dbUrl); isolatedUrl.pathname = `/${database}`;
  const pool = new Pool({ connectionString: isolatedUrl.toString(), max: 10 });
  t.after(async () => { await pool.end(); const cleanup = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    try { await cleanup.query(`DROP DATABASE ${database} WITH (FORCE)`); } finally { await cleanup.end(); } });

  const tag = suffix;
  const addUser = async (name) => (await pool.query(`INSERT INTO identity.users(email,display_name,state) VALUES($1,$2,'active') RETURNING id`,
    [`ren2-75-${name}-${tag}@example.invalid`, name])).rows[0].id;
  const submitter = await addUser('submitter'); const operator = await addUser('operator'); const grantor = await addUser('grantor');
  const brand = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
    VALUES($1,'REN2-75 Test','REN2-75 Test','approved') RETURNING id`, [`ren2-75-${tag}`])).rows[0].id;
  const permissionIds = (await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description)
    SELECT p,'catalog',split_part(p,'.',2),'REN2-75 synthetic integration' FROM unnest($1::text[]) p
    ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code RETURNING id`,
  [['catalog.review','catalog.publish','catalog.restrict']])).rows.map((row) => row.id);
  const role = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
    VALUES($1,'global','REN2-75 synthetic catalog role',false) RETURNING id`, [`ren2_75_${tag}`])).rows[0].id;
  for (const permissionId of permissionIds) await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2)', [role, permissionId]);
  await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,scope_type,active_from,granted_by_id)
    VALUES($1,$2,'global',now(),$3)`, [operator, role, grantor]);

  const category = (await pool.query(`INSERT INTO catalogue.categories(code,name) VALUES($1,'REN2-75 Test') RETURNING id`, [`ren2-75-${tag}`])).rows[0].id;
  const schema = (await pool.query(`INSERT INTO catalogue.category_schema_versions(category_id,version,ruleset,ruleset_sha256,validator_version)
    VALUES($1,1,'{}'::jsonb,repeat('a',64),'ren2-75-test') RETURNING id`, [category])).rows[0].id;
  await pool.query(`UPDATE catalogue.category_schema_versions SET state='PUBLISHED',approved_by=$2,published_at=now() WHERE id=$1`, [schema, operator]);
  const taxonomy = await pool.connect();
  try { await taxonomy.query('BEGIN'); await taxonomy.query(`SELECT set_config('app.taxonomy_actor_user_id',$1,true),
    set_config('app.taxonomy_request_id',$2,true),set_config('app.taxonomy_reason_code','REN2_75_TEST',true)`, [operator, `activate-${tag}`]);
    await taxonomy.query('UPDATE catalogue.categories SET active=true WHERE id=$1', [category]); await taxonomy.query('COMMIT');
  } catch (error) { await taxonomy.query('ROLLBACK'); throw error; } finally { taxonomy.release(); }

  const product = randomUUID(); const variant = randomUUID();
  const price = randomUUID(); const expiredPrice = randomUUID(); const revision = randomUUID();
  await pool.query(`INSERT INTO catalogue.products(id,brand_id,category_id,style_code,title,description,category_schema_version,publication_state,qc_state)
    VALUES($1,$2,$3,$4,'REN2-75 cotton tee','Blue shirt',1,'PENDING_REVIEW','PENDING')`, [product, brand, category, `STYLE-${tag}`]);
  await pool.query(`INSERT INTO catalogue.product_variants(id,brand_id,product_id,sku,option_signature,options,variant_state)
    VALUES($1,$2,$3,$4,'default','{}','ACTIVE')`, [variant, brand, product, `SKU-${tag.slice(0,20)}`]);
  await pool.query(`INSERT INTO catalogue.variant_prices(id,brand_id,variant_id,currency,amount_minor,mrp_minor,valid_from,valid_to,price_state,rule_version)
    VALUES($1,$2,$3,'INR',5000,7000,now()-interval '1 day',now()+interval '1 day','APPROVED',1)`, [price, brand, variant]);

  const asset = randomUUID(); const mediaLink = randomUUID();
  await pool.query(`INSERT INTO media.media_assets(id,brand_id,storage_key,sha256,mime_type,scan_state,rights_state,derivative_state,
    completed_at,rights_attested_by,rights_attested_at) VALUES($1,$2,$3,NULL,'image/webp','PENDING','ATTESTED','PENDING',NULL,$4,now())`,
  [asset, brand, `ren2-75/${tag}`, submitter]);
  for (const kind of ['PREVIEW','THUMBNAIL']) await pool.query(`INSERT INTO media.media_derivatives
    (brand_id,media_asset_id,derivative_kind,storage_key,sha256,mime_type,byte_length,width,height)
    VALUES($1,$2,$3,$4,repeat('c',64),'image/webp',16,400,400)`, [brand, asset, kind, `ren2-75/${tag}/${kind}`]);
  await pool.query(`UPDATE media.media_assets SET sha256=repeat('b',64),scan_state='CLEAN',derivative_state='READY',completed_at=now(),row_version=row_version+1 WHERE id=$1`, [asset]);
  await pool.query(`INSERT INTO media.product_media(id,brand_id,product_id,media_asset_id,display_role,display_order,alt_text)
    VALUES($1,$2,$3,$4,'PRIMARY',0,'Front view')`, [mediaLink, brand, product, asset]);
  const snapshot = { schema: 'renivet.product-revision.v1', product: { id: product, brandId: brand, categoryId: category,
    categorySchemaVersion: 1, styleCode: `STYLE-${tag}`, title: 'REN2-75 cotton tee', description: 'Blue shirt', contentVersion: 1 },
    attributes: {}, attributeRules: {}, variants: [{ id: variant, sku: `SKU-${tag.slice(0,20)}`, approvedPrice: { id: price } }],
    media: [{ id: mediaLink, assetId: asset }], claims: [], sourceLineage: [] };
  await pool.query(`INSERT INTO catalogue.product_revisions(id,brand_id,product_id,content_version,content_snapshot,content_sha256,submitted_by,review_state,category_id,category_schema_version)
    VALUES($1,$2,$3,1,$4::jsonb,$5,$6,'SUBMITTED',$7,1)`, [revision, brand, product, JSON.stringify(snapshot), snapshotSha256(snapshot), submitter, category]);
  const review = await new CatalogReviewPostgresRepository({ pool }).decide(product, { decision: 'APPROVED', reasonCode: 'QC_PASSED',
    expectedRevisionId: revision, expectedRowVersion: 1 }, { userId: operator, brandId: brand, idempotencyKey: `review-${tag}` });
  const publication = new CatalogPublicationPostgresRepository({ pool });
  const published = await publication.publish(product, { approvedRevisionId: revision, approvedReviewId: review.decisionId },
    { userId: operator, brandId: brand, expectedProductVersion: review.rowVersion, idempotencyKey: `publish-${tag}` });
  await pool.query(`INSERT INTO catalogue.variant_prices(id,brand_id,variant_id,currency,amount_minor,mrp_minor,valid_from,valid_to,price_state,rule_version)
    VALUES($1,$2,$3,'INR',4000,7000,now()-interval '3 days',now()-interval '2 days','APPROVED',1)`, [expiredPrice, brand, variant]);

  const port = new CatalogBuyabilityPostgresPort(['w3.checkout.synthetic']);
  const request = { brandId: brand, productId: product, variantId: variant, sku: `SKU-${tag.slice(0,20)}`,
    expectedPublicationVersion: published.publicationVersion, expectedPriceId: price, expectedPriceRowVersion: 1 };
  const checkout = await pool.connect();
  try {
    await checkout.query('BEGIN');
    const accepted = await port.validate(checkout, request, 'w3.checkout.synthetic');
    assert.equal(accepted.decision, 'BUYABLE'); assert.equal(accepted.contractVersion, 1);
    assert.equal(accepted.catalogEligible, true); assert.equal(accepted.stockAllocation, 'NOT_CHECKED');
    assert.equal(accepted.price.amountMinor, 5000); assert.equal(accepted.revisionId, revision);
    const stalePublication = await port.validate(checkout, { ...request, expectedPublicationVersion: request.expectedPublicationVersion - 1 }, 'w3.checkout.synthetic');
    assert.equal(stalePublication.code, 'STALE_PUBLICATION');
    const expired = await port.validate(checkout, { ...request, expectedPriceId: expiredPrice }, 'w3.checkout.synthetic');
    assert.deepEqual(expired, { contractVersion: 1, decision: 'DENIED', code: 'PRICE_EXPIRED', catalogEligible: false, stockAllocation: 'NOT_CHECKED' });
    const wrongBrand = await port.validate(checkout, { ...request, brandId: randomUUID() }, 'w3.checkout.synthetic');
    const wrongSku = await port.validate(checkout, { ...request, sku: 'FOREIGN-SKU' }, 'w3.checkout.synthetic');
    assert.deepEqual(wrongBrand, wrongSku); assert.equal(wrongBrand.code, 'NOT_BUYABLE');
    await checkout.query('COMMIT');
  } catch (error) { await checkout.query('ROLLBACK'); throw error; } finally { checkout.release(); }

  await pool.query("UPDATE brands.brands SET onboarding_state='suspended' WHERE id=$1", [brand]);
  const suspendedRecheck = await pool.connect();
  try {
    await suspendedRecheck.query('BEGIN');
    const denied = await port.validate(suspendedRecheck, request, 'w3.checkout.synthetic');
    assert.equal(denied.decision, 'DENIED');
    assert.equal(denied.code, 'NOT_BUYABLE');
    await suspendedRecheck.query('ROLLBACK');
  } finally { suspendedRecheck.release(); }
  const retainedProduct = await pool.query('SELECT publication_state FROM catalogue.products WHERE id=$1 AND brand_id=$2', [product, brand]);
  assert.equal(retainedProduct.rows[0]?.publication_state, 'PUBLISHED', 'brand suspension suppresses buyability without deleting or rewriting the published product');
  await pool.query("UPDATE brands.brands SET onboarding_state='approved' WHERE id=$1", [brand]);

  const restricted = await publication.restrict(product, { reasonCode: 'SAFETY_RECALL' }, { userId: operator, brandId: brand,
    expectedProductVersion: published.rowVersion, idempotencyKey: `restrict-${tag}` });
  const recheck = await pool.connect();
  try {
    await recheck.query('BEGIN');
    const denied = await port.validate(recheck, request, 'w3.checkout.synthetic');
    assert.equal(denied.decision, 'DENIED'); assert.equal(denied.code, 'NOT_BUYABLE');
    await recheck.query('ROLLBACK');
  } finally { recheck.release(); }
  const unauthorized = await pool.connect();
  try { await assert.rejects(port.validate(unauthorized, request, 'w3.real-checkout'), (error) => error.code === 'CATALOG_BUYABILITY_CALLER_DENIED'); }
  finally { unauthorized.release(); }
  assert.equal(restricted.status, 'RESTRICTED');
});
