'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { ClaimsPostgresRepository } = require('../../dist/modules/catalog/claims.repository.js');

const url = process.env.RENIVET_TEST_DATABASE_URL;
function code(expected) { return (error) => error?.code === expected; }
function adminUrl(value) { const parsed = new URL(value); parsed.pathname = '/postgres'; return parsed.toString(); }
function assertDisposable(value) {
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required for REN2-68 integration tests');
  const parsed = new URL(value);
  assert.equal(parsed.protocol, 'postgresql:'); assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.username, 'renivet_ci'); assert.equal(parsed.pathname, '/renivet_ci');
}

test('REN2-68/69 claims remain pending until independent, audited moderation and stale decisions cannot win', {
  skip: !url && 'requires the disposable PostgreSQL 16 database', timeout: 90_000,
}, async (t) => {
  assertDisposable(url);
  const database = `ren2_68_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: adminUrl(url), max: 1, connectionTimeoutMillis: 5_000 });
  const templatePool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
  let version;
  try { version = Number((await templatePool.query('SHOW server_version_num')).rows[0].server_version_num); }
  finally { await templatePool.end(); }
  try {
    assert.ok(version >= 160000 && version < 170000, 'REN2-68 requires disposable PostgreSQL 16');
    assert.equal((await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]?.rolsuper, true);
    await admin.query(`CREATE DATABASE ${database} TEMPLATE renivet_ci`);
  } finally { await admin.end(); }

  const target = new URL(url); target.pathname = `/${database}`;
  const pool = new Pool({ connectionString: target.toString(), max: 6, connectionTimeoutMillis: 5_000 });
  t.after(async () => {
    await pool.end();
    const cleanup = new Pool({ connectionString: adminUrl(url), max: 1, connectionTimeoutMillis: 5_000 });
    try { await cleanup.query(`DROP DATABASE ${database} WITH (FORCE)`); } finally { await cleanup.end(); }
  });

  const suffix = randomUUID().replaceAll('-', '');
  const addUser = async (name) => (await pool.query(
    `INSERT INTO identity.users(email,display_name,state) VALUES($1,$2,'active') RETURNING id`,
    [`ren2-68-${name}-${suffix}@example.invalid`, name])).rows[0].id;
  const actor = await addUser('submitter'); const grantor = await addUser('grantor'); const reviewer = await addUser('reviewer');
  const revokedActor = await addUser('revoked'); const racingActor = await addUser('racing'); const brandOnlyReviewer = await addUser('brand-only-reviewer');
  const brand = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
    VALUES($1,'REN2-68 Synthetic','REN2-68 Synthetic','approved') RETURNING id`, [`ren2-68-${suffix}`])).rows[0].id;
  const otherBrand = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
    VALUES($1,'REN2-68 Other','REN2-68 Other','approved') RETURNING id`, [`ren2-68-other-${suffix}`])).rows[0].id;
  for (const user of [actor, revokedActor, racingActor, brandOnlyReviewer]) await pool.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at)
    VALUES($1,$2,'active',$3,now())`, [brand, user, grantor]);
  const role = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
    VALUES($1,'brand','REN2-68 disposable role',false) RETURNING id`, [`ren2_68_${suffix}`])).rows[0].id;
  const permissionIds = [];
  for (const [permissionCode, action] of [['catalog.write','write'],['catalog.read','read'],['catalog.review','review']]) {
    permissionIds.push((await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description)
      VALUES($1,'catalog',$2,'REN2-68 integration') ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code RETURNING id`,
    [permissionCode, action])).rows[0].id);
  }
  const reviewPermission = (await pool.query(`SELECT id FROM access.permissions WHERE permission_code='catalog.review'`)).rows[0].id;
  const globalReviewerRole = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
    VALUES($1,'global','REN2-69 synthetic reviewer',false) RETURNING id`, [`ren2_69_reviewer_${suffix}`])).rows[0].id;
  await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2)', [globalReviewerRole, reviewPermission]);
  for (const user of [actor, reviewer]) await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
    VALUES($1,$2,NULL,'global',now(),$3)`, [user, globalReviewerRole, grantor]);
  for (const permissionId of permissionIds) await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [role, permissionId]);
  for (const user of [actor, revokedActor, racingActor, brandOnlyReviewer]) await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
    VALUES($1,$2,$3,'brand',now(),$4)`, [user, role, brand, grantor]);
  await pool.query(`UPDATE brands.brand_memberships SET membership_state='revoked',row_version=row_version+1,updated_at=now()
    WHERE brand_id=$1 AND user_id=$2`, [brand, revokedActor]);

  const categoryId = (await pool.query(`INSERT INTO catalogue.categories(code,name) VALUES($1,'REN2-68 test') RETURNING id`, [`ren2-68-${suffix}`])).rows[0].id;
  await pool.query(`INSERT INTO catalogue.category_schema_versions(category_id,version,ruleset_sha256,validator_version)
    VALUES($1,1,repeat('a',64),'ren2-68-test')`, [categoryId]);
  const product = (await pool.query(`INSERT INTO catalogue.products(brand_id,category_id,style_code,title,category_schema_version)
    VALUES($1,$2,$3,'Claim product',1) RETURNING id`, [brand, categoryId, `REN2-68-${suffix}`])).rows[0].id;
  const otherProduct = (await pool.query(`INSERT INTO catalogue.products(brand_id,category_id,style_code,title,category_schema_version)
    VALUES($1,$2,$3,'Other product',1) RETURNING id`, [otherBrand, categoryId, `REN2-68-OTHER-${suffix}`])).rows[0].id;
  const revision = (await pool.query(`INSERT INTO catalogue.product_revisions
    (brand_id,product_id,content_version,content_snapshot,content_sha256,submitted_by,review_state,category_id,category_schema_version)
    VALUES($1,$2,1,'{}'::jsonb,$3,$4,'SUBMITTED',$5,1) RETURNING id`, [brand, product, 'a'.repeat(64), actor, categoryId])).rows[0].id;
  const approval = (await pool.query(`INSERT INTO catalogue.product_qc_reviews
    (brand_id,product_id,revision_id,reviewer_user_id,decision,reason_code) VALUES($1,$2,$3,$4,'APPROVED','REN2_68_TEST') RETURNING id`,
  [brand, product, revision, reviewer])).rows[0].id;
  await pool.query(`UPDATE catalogue.products SET publication_state='PUBLISHED',qc_state='APPROVED',published_revision_id=$2,
    published_approval_id=$3,published_approval_decision='APPROVED' WHERE id=$1`, [product, revision, approval]);
  const asset = async (owner, label, clean = true) => {
    const client = await pool.connect(); const id = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO media.media_assets
        (id,brand_id,storage_key,sha256,mime_type,scan_state,rights_state,derivative_state,completed_at,rights_attested_by,rights_attested_at)
        VALUES($1,$2,$3,$4,'image/webp',$5,$6,$7,$8,$9,$10)`,
      [id, owner, `ren2-68/${label}/${suffix}`, clean ? 'b'.repeat(64) : null, clean ? 'CLEAN' : 'PENDING', clean ? 'ATTESTED' : 'UNVERIFIED',
        clean ? 'READY' : 'PENDING', clean ? new Date() : null, clean ? actor : null, clean ? new Date() : null]);
      if (clean) for (const kind of ['PREVIEW','THUMBNAIL']) await client.query(`INSERT INTO media.media_derivatives
        (brand_id,media_asset_id,derivative_kind,storage_key,sha256,mime_type,byte_length,width,height)
        VALUES($1,$2,$3,$4,$5,'image/webp',16,400,400)`,
      [owner, id, kind, `ren2-68/${label}/${id}/${kind.toLowerCase()}`, 'c'.repeat(64)]);
      await client.query('COMMIT'); return id;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  const cleanAsset = await asset(brand, 'clean'); const foreignAsset = await asset(otherBrand, 'foreign'); const pendingAsset = await asset(brand, 'pending', false);
  const repository = new ClaimsPostgresRepository({ pool });
  const context = (key, overrides = {}) => ({ brandId: brand, userId: actor, permission: 'catalog.write', requestId: `ren2-68:${key}`, idempotencyKey: key, ...overrides });
  const proposal = { claimCode: 'RECYCLED_CONTENT', claimText: 'Contains recycled material', evidenceAssetIds: [cleanAsset], expiresAt: null };
  const key = `claim-${suffix}`;

  await assert.rejects(repository.propose(product, proposal, 2, context(`stale-${suffix}`)), code('CLAIM_VERSION_CONFLICT'));
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catalogue.sustainability_claims WHERE product_id=$1', [product])).rows[0].count, 0,
    'a stale If-Match creates no claim or evidence rows');
  const pending = await repository.propose(product, proposal, 1, context(key));
  assert.equal(pending.claimState, 'PENDING', 'submitting brand evidence never auto-verifies a label');
  assert.deepEqual(await repository.propose(product, proposal, 1, context(key)), pending, 'same idempotency key returns the committed result');
  assert.doesNotMatch(JSON.stringify(pending), /storage_key|signedUrl|https?:\/\//i, 'no private evidence URL or storage key is returned');
  const receiptId = (await pool.query('SELECT id FROM catalogue.claim_mutation_receipts WHERE claim_id=$1', [pending.id])).rows[0].id;
  await assert.rejects(pool.query('UPDATE catalogue.claim_mutation_receipts SET response_payload=\'{}\'::jsonb WHERE id=$1', [receiptId]),
    (error) => error.code === '23514' && /IMMUTABLE_RECORD/.test(error.message), 'idempotency receipts cannot be changed');
  await assert.rejects(repository.propose(product, { ...proposal, claimText: 'Changed' }, 1, context(key)), code('CLAIM_IDEMPOTENCY_CONFLICT'));
  await assert.rejects(repository.propose(product, { ...proposal, evidenceAssetIds: [foreignAsset] }, 1, context(`foreign-${suffix}`)), code('CLAIM_EVIDENCE_NOT_ACCESSIBLE'));
  await assert.rejects(repository.propose(product, { ...proposal, evidenceAssetIds: [pendingAsset] }, 1, context(`unclean-${suffix}`)), code('CLAIM_EVIDENCE_NOT_ACCESSIBLE'));
  await assert.rejects(repository.propose(otherProduct, proposal, 1, context(`cross-product-${suffix}`)), code('CLAIM_PRODUCT_NOT_FOUND'));
  await assert.rejects(repository.propose(product, proposal, 1, context(`revoked-${suffix}`, { userId: revokedActor })), code('CLAIM_PRODUCT_NOT_FOUND'));
  let revokedAtReceipt = false;
  const racePool = { connect: async () => {
    const client = await pool.connect(); const query = client.query.bind(client);
    client.query = async (sql, ...params) => {
      if (!revokedAtReceipt && String(sql).includes('INSERT INTO catalogue.claim_mutation_receipts')) {
        await pool.query(`UPDATE brands.brand_memberships SET membership_state='revoked',row_version=row_version+1,updated_at=now()
          WHERE brand_id=$1 AND user_id=$2`, [brand, racingActor]);
        revokedAtReceipt = true;
      }
      return query(sql, ...params);
    };
    return client;
  } };
  const raceRepository = new ClaimsPostgresRepository({ pool: racePool });
  await assert.rejects(raceRepository.propose(product, proposal, 1, context(`race-revoke-${suffix}`, { userId: racingActor })), code('CLAIM_PERMISSION_REVOKED'));
  assert.equal(revokedAtReceipt, true, 'the fixture revokes current access at the final idempotency receipt boundary');
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catalogue.sustainability_claims WHERE product_id=$1', [product])).rows[0].count, 1,
    'denied, cross-brand and invalid evidence attempts leave no extra claim rows');

  const pendingVersion = Number(pending.rowVersion);
  await assert.rejects(repository.decide(pending.id, { decision: 'VERIFY', reasonCode: 'SELF_REVIEW' }, pendingVersion,
    context(`self-review-${suffix}`, { permission: 'catalog.review' })), code('CLAIM_MAKER_CHECKER_CONFLICT'));
  await assert.rejects(repository.decide(pending.id, { decision: 'VERIFY', reasonCode: 'EVIDENCE_VALID' }, pendingVersion,
    context(`brand-review-${suffix}`, { userId: brandOnlyReviewer, permission: 'catalog.review' })), code('CLAIM_NOT_FOUND'));
  await pool.query(`UPDATE catalogue.claim_evidence SET issuer='REN2-69 test issuer',document_reference='CERT-69',
    document_expires_at=now()+interval '1 day' WHERE claim_id=$1`, [pending.id]);
  const reviewerContext = (key, overrides = {}) => ({ brandId: brand, userId: reviewer, permission: 'catalog.review', requestId: `ren2-69:${key}`, idempotencyKey: key, ...overrides });
  const verifyInput = { decision: 'VERIFY', reasonCode: 'EVIDENCE_VALID', comment: 'Issuer and validity checked.' };
  const verifyContext = reviewerContext(`verify-${suffix}`);
  const verified = await repository.decide(pending.id, verifyInput, pendingVersion, verifyContext);
  assert.deepEqual({ state: verified.claimState, version: verified.rowVersion }, { state: 'VERIFIED', version: Number(pending.rowVersion) + 1 });
  assert.deepEqual(await repository.decide(pending.id, verifyInput, pendingVersion, verifyContext), verified, 'exact decision replay returns the original receipt');
  await assert.rejects(repository.decide(pending.id, { ...verifyInput, reasonCode: 'CHANGED' }, pendingVersion, verifyContext), code('CLAIM_IDEMPOTENCY_CONFLICT'));
  assert.equal((await pool.query('SELECT submitted_by FROM catalogue.sustainability_claims WHERE id=$1', [pending.id])).rows[0].submitted_by, actor);
  const audit = (await pool.query('SELECT reviewer_user_id,previous_state,next_state,claim_row_version,reviewer_comment FROM catalogue.claim_review_events WHERE claim_id=$1 ORDER BY recorded_at DESC LIMIT 1', [pending.id])).rows[0];
  assert.equal(audit.reviewer_user_id, reviewer);
  assert.deepEqual({ previous: audit.previous_state, next: audit.next_state, version: Number(audit.claim_row_version), comment: audit.reviewer_comment },
    { previous: 'PENDING', next: 'VERIFIED', version: Number(verified.rowVersion), comment: 'Issuer and validity checked.' });
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM platform.outbox_events WHERE aggregate_id=$1 AND event_type=\'catalogue.product.listing_recheck_requested\'', [product])).rows[0].count, 1);
  const longClaimExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000).toISOString();
  const secondPending = await repository.propose(product, { ...proposal, claimCode: 'ORGANIC_MATERIAL', expiresAt: longClaimExpiry }, 1,
    context(`expiry-conflict-${suffix}`));
  await assert.rejects(repository.decide(secondPending.id, verifyInput, Number(secondPending.rowVersion), verifyContext), code('CLAIM_IDEMPOTENCY_CONFLICT'));
  await pool.query(`UPDATE catalogue.claim_evidence SET issuer='REN2-69 issuer',document_reference='SHORT-CERT',
    document_expires_at=now()+interval '1 day' WHERE claim_id=$1`, [secondPending.id]);
  await assert.rejects(repository.decide(secondPending.id, { decision: 'VERIFY', reasonCode: 'EVIDENCE_VALID' },
    Number(secondPending.rowVersion), reviewerContext(`expiry-mismatch-${suffix}`)), code('CLAIM_EVIDENCE_EXPIRY_CONFLICT'));
  assert.equal((await pool.query('SELECT claim_state FROM catalogue.sustainability_claims WHERE id=$1', [secondPending.id])).rows[0].claim_state, 'PENDING',
    'a claim expiry after its proof expiry leaves the claim pending');
  assert.equal((await pool.query('SELECT evidence_state FROM catalogue.claim_evidence WHERE claim_id=$1', [secondPending.id])).rows[0].evidence_state, 'PENDING',
    'an invalid expiry decision does not partially accept evidence');
  const rejected = await repository.decide(secondPending.id, { decision: 'REJECT', reasonCode: 'EVIDENCE_INSUFFICIENT' },
    Number(secondPending.rowVersion), reviewerContext(`reject-${suffix}`));
  assert.equal(rejected.claimState, 'REJECTED');
  let listed = await repository.list(product, { userId: actor, brandId: brand, permission: 'catalog.read' });
  assert.equal(listed.items.find((item) => item.id === pending.id).claimState, 'VERIFIED');
  assert.deepEqual(listed.items.find((item) => item.id === pending.id).evidenceAssetIds, [cleanAsset]);
  await assert.rejects(repository.list(product, { userId: revokedActor, brandId: brand, permission: 'catalog.read' }), code('CLAIM_PRODUCT_NOT_FOUND'));
  await pool.query(`UPDATE catalogue.claim_evidence SET evidence_state='PENDING' WHERE claim_id=$1`, [pending.id]);
  listed = await repository.list(product, { userId: actor, brandId: brand, permission: 'catalog.read' });
  assert.equal(listed.items.find((item) => item.id === pending.id).claimState, 'PENDING', 'pending evidence cannot be mislabeled as a revocation');
  await pool.query(`UPDATE catalogue.claim_evidence SET evidence_state='REJECTED' WHERE claim_id=$1`, [pending.id]);
  listed = await repository.list(product, { userId: actor, brandId: brand, permission: 'catalog.read' });
  assert.equal(listed.items.find((item) => item.id === pending.id).claimState, 'REJECTED', 'rejected evidence suppresses verification without inventing a recall');
  await pool.query(`UPDATE catalogue.claim_evidence SET evidence_state='ACCEPTED' WHERE claim_id=$1`, [pending.id]);
  await pool.query(`UPDATE catalogue.claim_evidence SET document_expires_at=now()-interval '1 second' WHERE claim_id=$1`, [pending.id]);
  listed = await repository.list(product, { userId: actor, brandId: brand, permission: 'catalog.read' });
  assert.equal(listed.items.find((item) => item.id === pending.id).claimState, 'EXPIRED', 'expired supporting evidence suppresses the verified label immediately');
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM platform.outbox_events WHERE aggregate_id=$1 AND event_type=\'catalogue.product.listing_recheck_requested\'', [product])).rows[0].count, 3,
    'observing expired evidence enqueues one idempotent listing recheck');
  const revokeRace = await Promise.allSettled([
    repository.decide(pending.id, { decision: 'REVOKE', reasonCode: 'EVIDENCE_WITHDRAWN' }, Number(verified.rowVersion), reviewerContext(`revoke-a-${suffix}`)),
    repository.decide(pending.id, { decision: 'REVOKE', reasonCode: 'EVIDENCE_WITHDRAWN' }, Number(verified.rowVersion), reviewerContext(`revoke-b-${suffix}`)),
  ]);
  assert.equal(revokeRace.filter((result) => result.status === 'fulfilled').length, 1, 'exactly one concurrent reviewer transition wins');
  assert.equal(revokeRace.filter((result) => result.status === 'rejected' && result.reason.code === 'CLAIM_VERSION_CONFLICT').length, 1,
    'the stale competing reviewer cannot write a second valid outcome');
  assert.equal((await pool.query('SELECT claim_state,reviewed_by,row_version FROM catalogue.sustainability_claims WHERE id=$1', [pending.id])).rows[0].claim_state, 'REVOKED');
  await pool.query(`UPDATE catalogue.claim_evidence SET document_expires_at=NULL,recalled_at=now(),recall_reason_code='RECALLED' WHERE claim_id=$1`, [pending.id]);
  listed = await repository.list(product, { userId: actor, brandId: brand, permission: 'catalog.read' });
  assert.equal(listed.items.find((item) => item.id === pending.id).claimState, 'REVOKED', 'recalled supporting evidence suppresses the verified label immediately');

  const event = (await pool.query(`INSERT INTO catalogue.claim_review_events(brand_id,product_id,claim_id,review_action,reviewer_user_id,reason_code)
    VALUES($1,$2,$3,'REVOKE',$4,'EVIDENCE_RECALLED') RETURNING id`, [brand, product, pending.id, reviewer])).rows[0].id;
  await assert.rejects(pool.query('UPDATE catalogue.claim_review_events SET reason_code=\'changed\' WHERE id=$1', [event]),
    (error) => error.code === '23514' && /IMMUTABLE_RECORD/.test(error.message), 'review reasons remain append-only history');
  await assert.rejects(repository.list(otherProduct, { userId: actor, brandId: brand, permission: 'catalog.read' }), code('CLAIM_PRODUCT_NOT_FOUND'));
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catalogue.sustainability_claims WHERE product_id=$1', [otherProduct])).rows[0].count, 0,
    'denied cross-brand reads do not affect unrelated product records');
});
