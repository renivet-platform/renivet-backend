'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { CatalogReviewPostgresRepository } = require('../../dist/modules/catalog/catalog-review.repository.js');
const { snapshotSha256 } = require('../../dist/modules/catalog/catalog-submission.js');

const url = process.env.RENIVET_TEST_DATABASE_URL;
const code = (expected) => (error) => error?.code === expected;

test('REN2-72 exact revision review enforces maker-checker, live eligibility, immutable audit and concurrency', {
  skip: !url && 'requires disposable PostgreSQL 16', timeout: 60_000,
}, async (t) => {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'postgresql:'); assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.username, 'renivet_ci'); assert.equal(parsed.pathname, '/renivet_ci');
  const pool = new Pool({ connectionString: url, max: 8 });
  t.after(() => pool.end());
  const version = Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 160000 && version < 170000, 'test requires PostgreSQL 16');
  const suffix = randomUUID().replaceAll('-', '');
  const addUser = async (label) => (await pool.query(
    `INSERT INTO identity.users(email,display_name,state) VALUES($1,$2,'active') RETURNING id`,
    [`ren2-72-${label}-${suffix}@example.invalid`, label])).rows[0].id;
  const submitter = await addUser('submitter'); const reviewer = await addUser('reviewer');
  const brand = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
    VALUES($1,'REN2-72 Test','REN2-72 Test','approved') RETURNING id`, [`ren2-72-${suffix}`])).rows[0].id;
  const permissionId = (await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description)
    VALUES('catalog.review','catalog','review','REN2-72 integration test') ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code RETURNING id`)).rows[0].id;
  const globalRole = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
    VALUES($1,'global','REN2-72 global reviewer',false) RETURNING id`, [`ren2_72_global_${suffix}`])).rows[0].id;
  await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [globalRole, permissionId]);
  const grantor = await addUser('grantor');
  for (const userId of [submitter, reviewer]) await pool.query(`INSERT INTO access.role_assignments
    (user_id,role_id,brand_id,scope_type,active_from,granted_by_id) VALUES($1,$2,NULL,'global',now(),$3)`, [userId, globalRole, grantor]);
  const brandOnly = await addUser('brand-only');
  const brandRole = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
    VALUES($1,'brand','REN2-72 brand reviewer',false) RETURNING id`, [`ren2_72_brand_${suffix}`])).rows[0].id;
  await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2)', [brandRole, permissionId]);
  await pool.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at)
    VALUES($1,$2,'active',$3,now())`, [brand, brandOnly, grantor]);
  await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
    VALUES($1,$2,$3,'brand',now(),$4)`, [brandOnly, brandRole, brand, grantor]);

  const categoryId = (await pool.query(`INSERT INTO catalogue.categories(code,name) VALUES($1,'REN2-72 test') RETURNING id`, [`ren2-72-${suffix}`])).rows[0].id;
  await pool.query(`INSERT INTO catalogue.category_schema_versions(category_id,version,ruleset_sha256,validator_version)
    VALUES($1,1,repeat('a',64),'ren2-72-test')`, [categoryId]);
  const repository = new CatalogReviewPostgresRepository({ pool });

  const fixture = async (label, withClaim = false, priceState = 'APPROVED') => {
    const productId = randomUUID(); const variantId = randomUUID(); const priceId = randomUUID();
    const mediaAssetId = randomUUID(); const mediaLinkId = randomUUID(); const revisionId = randomUUID();
    const claimId = withClaim ? randomUUID() : null;
    const product = (await pool.query(`INSERT INTO catalogue.products
      (id,brand_id,category_id,style_code,title,category_schema_version,publication_state,qc_state)
      VALUES($1,$2,$3,$4,$5,1,'PENDING_REVIEW','PENDING') RETURNING row_version`,
    [productId, brand, categoryId, `sku-${label}-${suffix}`, `Product ${label}`])).rows[0];
    await pool.query(`INSERT INTO catalogue.product_variants(id,brand_id,product_id,sku,option_signature,options,variant_state)
      VALUES($1,$2,$3,$4,$5,'{}'::jsonb,'ACTIVE')`, [variantId, brand, productId, `v-${label}-${suffix.slice(0, 20)}`, `sig-${label}`]);
    await pool.query(`INSERT INTO catalogue.variant_prices(id,brand_id,variant_id,currency,amount_minor,mrp_minor,valid_from,valid_to,price_state,rule_version)
      VALUES($1,$2,$3,'INR',5000,7000,now()-interval '1 day',now()+interval '1 day',$4,1)`, [priceId, brand, variantId, priceState]);
    await pool.query(`INSERT INTO media.media_assets(id,brand_id,storage_key,sha256,mime_type,scan_state,rights_state,
      derivative_state,completed_at,rights_attested_by,rights_attested_at)
      VALUES($1,$2,$3,NULL,'image/webp','PENDING','ATTESTED','PENDING',NULL,$4,now())`, [mediaAssetId, brand, `ren2-72/${label}/${suffix}`, submitter]);
    for (const kind of ['PREVIEW','THUMBNAIL']) await pool.query(`INSERT INTO media.media_derivatives
      (brand_id,media_asset_id,derivative_kind,storage_key,sha256,mime_type,byte_length,width,height)
      VALUES($1,$2,$3,$4,repeat('c',64),'image/webp',16,400,400)`, [brand, mediaAssetId, kind, `ren2-72/${label}/${kind}/${suffix}`]);
    await pool.query(`UPDATE media.media_assets SET sha256=repeat('b',64),scan_state='CLEAN',derivative_state='READY',completed_at=now(),row_version=row_version+1
      WHERE id=$1`, [mediaAssetId]);
    await pool.query(`INSERT INTO media.product_media(id,brand_id,product_id,media_asset_id,display_role,display_order,alt_text)
      VALUES($1,$2,$3,$4,'PRIMARY',0,'Product front')`, [mediaLinkId, brand, productId, mediaAssetId]);
    const claimState = withClaim ? [{ id: claimId, revisionId, code: 'RECYCLED_CONTENT', text: 'Recycled content', state: 'VERIFIED',
      approvedAt: new Date().toISOString(), expiresAt: null, evidence: [], evidenceEligible: true }] : [];
    const snapshot = { schema: 'renivet.product-revision.v1', product: { id: productId, brandId: brand, contentVersion: 1 },
      variants: [{ id: variantId, approvedPrice: { id: priceId } }], media: [{ id: mediaLinkId, assetId: mediaAssetId }], claims: claimState };
    const hash = snapshotSha256(snapshot);
    await pool.query(`INSERT INTO catalogue.product_revisions
      (id,brand_id,product_id,content_version,content_snapshot,content_sha256,submitted_by,review_state,category_id,category_schema_version)
      VALUES($1,$2,$3,1,$4::jsonb,$5,$6,'SUBMITTED',$7,1)`, [revisionId, brand, productId, JSON.stringify(snapshot), hash, submitter, categoryId]);
    if (withClaim) {
      await pool.query(`INSERT INTO catalogue.sustainability_claims
        (id,brand_id,product_id,revision_id,claim_code,claim_text,claim_state,approved_at,reviewed_by,submitted_by)
        VALUES($1,$2,$3,$4,'RECYCLED_CONTENT','Recycled content','VERIFIED',now(),$5,$6)`, [claimId, brand, productId, revisionId, reviewer, submitter]);
      await pool.query(`INSERT INTO catalogue.claim_evidence(brand_id,product_id,claim_id,media_asset_id,evidence_state,issuer,document_reference)
        VALUES($1,$2,$3,$4,'ACCEPTED','Test issuer','CERT-1')`, [brand, productId, claimId, mediaAssetId]);
    }
    return { productId, variantId, priceId, mediaAssetId, mediaLinkId, revisionId, claimId, rowVersion: Number(product.row_version) };
  };
  const context = (userId, key) => ({ userId, brandId: brand, idempotencyKey: key });
  const input = (revisionId, expectedRowVersion, decision = 'APPROVED', reasonCode = 'QC_PASSED') =>
    ({ decision, reasonCode, expectedRevisionId: revisionId, expectedRowVersion, comment: 'Evidence and listing reviewed.' });

  const target = await fixture('main');
  await assert.rejects(pool.query(`UPDATE catalogue.product_revisions SET review_state='APPROVED' WHERE id=$1`, [target.revisionId]),
    /CATALOG_REVIEW_ATOMIC_RECORDS_REQUIRED/, 'revision cannot enter a terminal review state without decision, audit and receipt');
  assert.equal((await pool.query('SELECT review_state FROM catalogue.product_revisions WHERE id=$1', [target.revisionId])).rows[0].review_state, 'SUBMITTED');
  await assert.rejects(repository.decide(target.productId, input(target.revisionId, target.rowVersion), context(brandOnly, `brand-only-${suffix}`)),
    code('CATALOG_REVIEW_NOT_FOUND'), 'brand-only review permission cannot satisfy the global checker requirement');
  await assert.rejects(repository.decide(target.productId, input(target.revisionId, target.rowVersion), context(submitter, `self-${suffix}`)),
    code('CATALOG_REVIEW_MAKER_CHECKER_CONFLICT'));
  await assert.rejects(repository.decide(randomUUID(), input(target.revisionId, target.rowVersion), context(reviewer, `cross-${suffix}`)),
    code('CATALOG_REVIEW_NOT_FOUND'), 'revision cannot be guessed through another product');
  await assert.rejects(pool.query(`INSERT INTO catalogue.product_qc_reviews
    (brand_id,product_id,revision_id,reviewer_user_id,decision,reason_code) VALUES($1,$2,$3,$4,'APPROVED','CROSS_PRODUCT')`,
  [brand, randomUUID(), target.revisionId, reviewer]), (error) => error.code === '23503', 'composite FK rejects a cross-product revision');

  const badPriceTarget = await fixture('bad-price', false, 'EXPIRED');
  await assert.rejects(repository.decide(badPriceTarget.productId, input(badPriceTarget.revisionId, badPriceTarget.rowVersion), context(reviewer, `bad-price-${suffix}`)),
    code('CATALOG_REVIEW_PRICE_INVALID'));
  await pool.query(`UPDATE media.product_media SET detached_at=now() WHERE id=$1`, [target.mediaLinkId]);
  await assert.rejects(repository.decide(target.productId, input(target.revisionId, target.rowVersion), context(reviewer, `bad-media-${suffix}`)),
    code('CATALOG_REVIEW_MEDIA_INVALID'));
  await pool.query(`UPDATE media.product_media SET detached_at=NULL WHERE id=$1`, [target.mediaLinkId]);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM catalogue.product_qc_reviews WHERE revision_id=$1', [target.revisionId])).rows[0].count, 0,
    'rejected price/media attempts leave no decision rows');
  assert.equal((await pool.query('SELECT review_state FROM catalogue.product_revisions WHERE id=$1', [target.revisionId])).rows[0].review_state, 'SUBMITTED');

  const evidenceTarget = await fixture('evidence', true);
  await pool.query(`UPDATE catalogue.claim_evidence SET evidence_state='REVOKED' WHERE claim_id=$1`, [evidenceTarget.claimId]);
  await assert.rejects(repository.decide(evidenceTarget.productId, input(evidenceTarget.revisionId, evidenceTarget.rowVersion), context(reviewer, `bad-evidence-${suffix}`)),
    code('CATALOG_REVIEW_EVIDENCE_INVALID'));
  await pool.query(`UPDATE catalogue.claim_evidence SET evidence_state='ACCEPTED' WHERE claim_id=$1`, [evidenceTarget.claimId]);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM catalogue.product_qc_reviews WHERE revision_id=$1', [evidenceTarget.revisionId])).rows[0].count, 0,
    'rejected evidence leaves no decision row');

  const decisionContext = context(reviewer, `approve-${suffix}`);
  const decisionInput = input(target.revisionId, target.rowVersion);
  const approved = await repository.decide(target.productId, decisionInput, decisionContext);
  assert.equal(approved.decision, 'APPROVED');
  assert.equal(approved.publicationState, 'APPROVED', 'QC approval does not publish the item');
  assert.deepEqual(await repository.decide(target.productId, decisionInput, decisionContext), approved, 'exact idempotent replay returns original response');
  await assert.rejects(repository.decide(target.productId, input(target.revisionId, target.rowVersion, 'REJECTED', 'CHANGED'), decisionContext),
    code('CATALOG_REVIEW_IDEMPOTENCY_CONFLICT'));
  const audit = (await pool.query(`SELECT reviewer_user_id,decision,reason_code,previous_review_state,next_review_state,product_row_version
    FROM catalogue.product_qc_review_events WHERE decision_id=$1`, [approved.decisionId])).rows[0];
  assert.deepEqual({ reviewer: audit.reviewer_user_id, decision: audit.decision, reason: audit.reason_code, before: audit.previous_review_state,
    after: audit.next_review_state, version: Number(audit.product_row_version) },
  { reviewer, decision: 'APPROVED', reason: 'QC_PASSED', before: 'SUBMITTED', after: 'APPROVED', version: 2 });
  const receipt = (await pool.query('SELECT id FROM catalogue.product_review_decision_receipts WHERE decision_id=$1', [approved.decisionId])).rows[0].id;
  await assert.rejects(pool.query(`UPDATE catalogue.product_review_decision_receipts SET response_payload='{}'::jsonb WHERE id=$1`, [receipt]), /IMMUTABLE_RECORD/);
  const eventId = (await pool.query('SELECT id FROM catalogue.product_qc_review_events WHERE decision_id=$1', [approved.decisionId])).rows[0].id;
  await assert.rejects(pool.query('DELETE FROM catalogue.product_qc_review_events WHERE id=$1', [eventId]), /IMMUTABLE_RECORD/);

  const raced = await fixture('race');
  const results = await Promise.allSettled([
    repository.decide(raced.productId, input(raced.revisionId, raced.rowVersion, 'APPROVED'), context(reviewer, `race-a-${suffix}`)),
    repository.decide(raced.productId, input(raced.revisionId, raced.rowVersion, 'REJECTED', 'QC_FAILED'), context(reviewer, `race-b-${suffix}`)),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, 'exactly one competing decision wins');
  assert.equal(results.filter((result) => result.status === 'rejected' && ['CATALOG_REVIEW_VERSION_CONFLICT', 'CATALOG_REVIEW_STATE_CONFLICT', 'CATALOG_REVIEW_ALREADY_DECIDED'].includes(result.reason.code)).length, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM catalogue.product_qc_reviews WHERE revision_id=$1', [raced.revisionId])).rows[0].count, 1);
});
