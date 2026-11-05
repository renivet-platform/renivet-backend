'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { CatalogReviewPostgresRepository } = require('../../dist/modules/catalog/catalog-review.repository.js');
const { CatalogPublicationPostgresRepository } = require('../../dist/modules/catalog/catalog-publication.repository.js');
const { snapshotSha256 } = require('../../dist/modules/catalog/catalog-submission.js');

const url = process.env.RENIVET_TEST_DATABASE_URL;
const errorCode = (code) => (error) => error?.code === code;

test('REN2-73 publishes exact approved revision atomically, replays safely, and records restrict/unpublish history', {
  skip: !url && 'requires disposable PostgreSQL 16', timeout: 60_000,
}, async (t) => {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'postgresql:'); assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.username, 'renivet_ci'); assert.equal(parsed.pathname, '/renivet_ci');
  const pool = new Pool({ connectionString: url, max: 8 }); t.after(() => pool.end());
  const serverVersion = Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(serverVersion >= 160000 && serverVersion < 170000, 'requires PostgreSQL 16');
  const tag = randomUUID().replaceAll('-', '');
  const user = async (label) => (await pool.query(`INSERT INTO identity.users(email,display_name,state)
    VALUES($1,$2,'active') RETURNING id`, [`ren2-73-${label}-${tag}@example.invalid`, label])).rows[0].id;
  const submitter = await user('submitter'); const operator = await user('operator'); const grantor = await user('grantor');
  const brand = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
    VALUES($1,'REN2-73 Test','REN2-73 Test','approved') RETURNING id`, [`ren2-73-${tag}`])).rows[0].id;

  const permissionCodes = ['catalog.review','catalog.publish','catalog.restrict'];
  const ids = (await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description)
    SELECT x,'catalog',split_part(x,'.',2),'REN2-73 integration test' FROM unnest($1::text[]) x
    ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code RETURNING id`, [permissionCodes])).rows.map((r) => r.id);
  const role = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
    VALUES($1,'global','REN2-73 synthetic reviewer/publisher',false) RETURNING id`, [`ren2_73_global_${tag}`])).rows[0].id;
  for (const permissionId of ids) await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2)', [role, permissionId]);
  for (const userId of [operator]) await pool.query(`INSERT INTO access.role_assignments
    (user_id,role_id,scope_type,active_from,granted_by_id) VALUES($1,$2,'global',now(),$3)`, [userId, role, grantor]);

  const category = (await pool.query(`INSERT INTO catalogue.categories(code,name) VALUES($1,'REN2-73 test') RETURNING id`, [`ren2-73-${tag}`])).rows[0].id;
  const schemaId = (await pool.query(`INSERT INTO catalogue.category_schema_versions
    (category_id,version,ruleset,ruleset_sha256,validator_version)
    VALUES($1,1,'{}'::jsonb,repeat('a',64),'ren2-73-test') RETURNING id`, [category])).rows[0].id;
  await pool.query(`UPDATE catalogue.category_schema_versions SET state='PUBLISHED',approved_by=$2,published_at=now() WHERE id=$1`, [schemaId, operator]);
  const categoryClient = await pool.connect();
  try {
    await categoryClient.query('BEGIN');
    await categoryClient.query("SELECT set_config('app.taxonomy_actor_user_id',$1,true),set_config('app.taxonomy_request_id',$2,true),set_config('app.taxonomy_reason_code','REN2_73_TEST',true)", [operator, `activate-${tag}`]);
    await categoryClient.query('UPDATE catalogue.categories SET active=true WHERE id=$1', [category]);
    await categoryClient.query('COMMIT');
  } catch (error) { await categoryClient.query('ROLLBACK'); throw error; }
  finally { categoryClient.release(); }
  assert.ok(schemaId);
  const productId = randomUUID(); const variantId = randomUUID(); const priceId = randomUUID();
  const assetId = randomUUID(); const linkId = randomUUID(); const revisionId = randomUUID();
  await pool.query(`INSERT INTO catalogue.products(id,brand_id,category_id,style_code,title,category_schema_version,publication_state,qc_state)
    VALUES($1,$2,$3,$4,'REN2-73 Product',1,'PENDING_REVIEW','PENDING')`, [productId, brand, category, `ren2-73-${tag}`]);
  await pool.query(`INSERT INTO catalogue.product_variants(id,brand_id,product_id,sku,option_signature,options,variant_state)
    VALUES($1,$2,$3,$4,'default','{}','ACTIVE')`, [variantId, brand, productId, `v-${tag.slice(0,24)}`]);
  await pool.query(`INSERT INTO catalogue.variant_prices(id,brand_id,variant_id,currency,amount_minor,mrp_minor,valid_from,valid_to,price_state,rule_version)
    VALUES($1,$2,$3,'INR',5000,7000,now()-interval '1 day',now()+interval '1 day','APPROVED',1)`, [priceId, brand, variantId]);
  await pool.query(`INSERT INTO media.media_assets(id,brand_id,storage_key,sha256,mime_type,scan_state,rights_state,derivative_state,
    completed_at,rights_attested_by,rights_attested_at) VALUES($1,$2,$3,NULL,'image/webp','PENDING','ATTESTED','PENDING',NULL,$4,now())`,
  [assetId, brand, `ren2-73/${tag}`, submitter]);
  for (const kind of ['PREVIEW','THUMBNAIL']) await pool.query(`INSERT INTO media.media_derivatives
    (brand_id,media_asset_id,derivative_kind,storage_key,sha256,mime_type,byte_length,width,height)
    VALUES($1,$2,$3,$4,repeat('c',64),'image/webp',16,400,400)`, [brand, assetId, kind, `ren2-73/${tag}/${kind}`]);
  await pool.query(`UPDATE media.media_assets SET sha256=repeat('b',64),scan_state='CLEAN',derivative_state='READY',completed_at=now(),row_version=row_version+1
    WHERE id=$1`, [assetId]);
  await pool.query(`INSERT INTO media.product_media(id,brand_id,product_id,media_asset_id,display_role,display_order,alt_text)
    VALUES($1,$2,$3,$4,'PRIMARY',0,'Product front')`, [linkId, brand, productId, assetId]);
  const snapshot = { schema: 'renivet.product-revision.v1', product: { id: productId, brandId: brand, categoryId: category,
    categorySchemaVersion: 1, contentVersion: 1 }, variants: [{ id: variantId, approvedPrice: { id: priceId } }],
    media: [{ id: linkId, assetId }], claims: [], attributes: {}, attributeRules: {}, sourceLineage: [] };
  await pool.query(`INSERT INTO catalogue.product_revisions(id,brand_id,product_id,content_version,content_snapshot,content_sha256,
    submitted_by,review_state,category_id,category_schema_version) VALUES($1,$2,$3,1,$4::jsonb,$5,$6,'SUBMITTED',$7,1)`,
  [revisionId, brand, productId, JSON.stringify(snapshot), snapshotSha256(snapshot), submitter, category]);

  const infrastructure = { pool };
  const reviewRepository = new CatalogReviewPostgresRepository(infrastructure);
  const review = await reviewRepository.decide(productId, { decision: 'APPROVED', reasonCode: 'QC_PASSED',
    expectedRevisionId: revisionId, expectedRowVersion: 1 }, { userId: operator, brandId: brand, idempotencyKey: `review-${tag}` });
  const publication = new CatalogPublicationPostgresRepository(infrastructure);
  const publishContext = { userId: operator, brandId: brand, expectedProductVersion: review.rowVersion, idempotencyKey: `publish-${tag}` };
  await assert.rejects(pool.query(`UPDATE catalogue.products SET publication_state='PUBLISHED',published_revision_id=$2,
    published_approval_id=$3,published_approval_decision='APPROVED',publication_version=publication_version+1
    WHERE id=$1`, [productId, revisionId, review.decisionId]), /CATALOG_PUBLICATION_ATOMIC_RECORDS_REQUIRED/,
  'database rolls back a versioned publish without matching lifecycle event, outbox, and receipt');
  assert.equal((await pool.query('SELECT publication_state FROM catalogue.products WHERE id=$1', [productId])).rows[0].publication_state, 'APPROVED');
  await assert.rejects(publication.publish(productId, { approvedRevisionId: randomUUID(), approvedReviewId: review.decisionId },
    { ...publishContext, idempotencyKey: `bad-${tag}` }), errorCode('CATALOG_PUBLICATION_APPROVAL_INVALID'));
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM catalogue.publication_events WHERE product_id=$1', [productId])).rows[0].n), 0,
    'invalid approved revision adds no publication event');
  const published = await publication.publish(productId, { approvedRevisionId: revisionId, approvedReviewId: review.decisionId }, publishContext);
  assert.equal(published.status, 'PUBLISHED'); assert.equal(published.revisionId, revisionId);
  assert.deepEqual(await publication.publish(productId, { approvedRevisionId: revisionId, approvedReviewId: review.decisionId }, publishContext), published,
    'same idempotency key and request replays the original receipt');
  const event = (await pool.query(`SELECT e.lifecycle_event,e.publication_version,o.event_type,o.event_key,r.id AS receipt
    FROM catalogue.publication_events e JOIN platform.outbox_events o ON o.id=e.event_id
    JOIN catalogue.publication_command_receipts r ON r.publication_event_id=e.event_id WHERE e.product_id=$1`, [productId])).rows[0];
  assert.equal(event.lifecycle_event, 'PUBLISH'); assert.equal(event.event_type, 'catalogue.product.published');
  assert.equal(event.event_key, `catalogue-publication:${productId}:2`); assert.ok(event.receipt);
  await assert.rejects(pool.query(`UPDATE catalogue.publication_events SET reason_code='CHANGED' WHERE product_id=$1`, [productId]), /IMMUTABLE_RECORD/);
  const restricted = await publication.restrict(productId, { reasonCode: 'SAFETY_RECALL', appealReference: 'CASE-733', comment: 'Safety review' },
    { ...publishContext, expectedProductVersion: published.rowVersion, idempotencyKey: `restrict-${tag}` });
  assert.equal(restricted.status, 'RESTRICTED');
  await assert.rejects(publication.publish(productId, { approvedRevisionId: revisionId, approvedReviewId: review.decisionId },
    { ...publishContext, expectedProductVersion: published.rowVersion, idempotencyKey: `stale-publish-${tag}` }), errorCode('CATALOG_PUBLICATION_VERSION_CONFLICT'),
  'a delayed publish with the pre-restriction version cannot override restriction');
  assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM catalogue.publication_events WHERE product_id=$1', [productId])).rows[0].n), 2);
  const unpublished = await publication.unpublish(productId, { reasonCode: 'SELLER_REQUEST' },
    { ...publishContext, expectedProductVersion: restricted.rowVersion, idempotencyKey: `unpublish-${tag}` });
  assert.equal(unpublished.status, 'APPROVED');
  assert.deepEqual((await pool.query(`SELECT lifecycle_event FROM catalogue.publication_events WHERE product_id=$1
    ORDER BY publication_version`, [productId])).rows.map((r) => r.lifecycle_event), ['PUBLISH','RESTRICT','UNPUBLISH']);
  const noPermission = await user('unauthorized');
  await assert.rejects(publication.publish(productId, { approvedRevisionId: revisionId, approvedReviewId: review.decisionId },
    { userId: noPermission, brandId: brand, expectedProductVersion: unpublished.rowVersion, idempotencyKey: `unauth-${tag}` }),
  errorCode('CATALOG_PUBLICATION_NOT_FOUND'));
});
