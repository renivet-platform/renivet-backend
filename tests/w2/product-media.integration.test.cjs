'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { ProductMediaPostgresRepository } = require('../../dist/modules/media/product-media.repository.js');

const url = process.env.RENIVET_TEST_DATABASE_URL;
function expectCode(code) { return (error) => error?.code === code; }
function assertDisposable(value) {
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required for REN2-67 integration tests');
  const parsed = new URL(value);
  assert.equal(parsed.protocol, 'postgresql:'); assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.username, 'renivet_ci'); assert.match(parsed.pathname, /^\/renivet_ci(?:_[a-z0-9_]+)?$/);
}
function adminConnectionString(value) { const parsed = new URL(value); parsed.pathname = '/postgres'; return parsed.toString(); }

test('REN2-67 enforces brand/product/variant media ownership, clean-rights eligibility, ordering CAS and immutable revision history on PostgreSQL 16', {
  skip: !url && 'requires the disposable PostgreSQL 16 database', timeout: 90_000,
}, async (t) => {
  assertDisposable(url);
  const template = new URL(url).pathname.slice(1);
  const database = `ren2_67_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = adminConnectionString(url);
  const admin = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5_000 });
  const source = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
  const version = await source.query('SHOW server_version_num');
  assert.ok(Number(version.rows[0].server_version_num) >= 160000 && Number(version.rows[0].server_version_num) < 170000);
  await source.end();
  try {
    assert.equal((await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]?.rolsuper, true,
      'integration fixture must clone only the disposable CI database');
    await admin.query(`CREATE DATABASE ${database} TEMPLATE ${template}`);
  } finally { await admin.end(); }
  const isolatedUrl = new URL(url); isolatedUrl.pathname = `/${database}`;
  const pool = new Pool({ connectionString: isolatedUrl.toString(), max: 8, connectionTimeoutMillis: 5_000 });
  t.after(async () => {
    await pool.end();
    const cleanup = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5_000 });
    try { await cleanup.query(`DROP DATABASE ${database} WITH (FORCE)`); } finally { await cleanup.end(); }
  });

  const suffix = randomUUID().replaceAll('-', '');
  const addUser = async (name) => (await pool.query(
    `INSERT INTO identity.users(email,display_name,state) VALUES($1,$2,'active') RETURNING id`,
    [`ren2-67-${name}-${suffix}@example.invalid`, name])).rows[0].id;
  const actor = await addUser('owner'); const grantor = await addUser('grantor'); const reviewer = await addUser('reviewer');
  const revokedActor = await addUser('revoked');
  const brand = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
    VALUES($1,'REN2-67 Synthetic','REN2-67 Synthetic','approved') RETURNING id`, [`ren2-67-${suffix}`])).rows[0].id;
  const otherBrand = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
    VALUES($1,'REN2-67 Other','REN2-67 Other','approved') RETURNING id`, [`ren2-67-other-${suffix}`])).rows[0].id;
  for (const user of [actor, reviewer, revokedActor]) await pool.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at)
    VALUES($1,$2,'active',$3,now())`, [brand, user, grantor]);
  await pool.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at)
    VALUES($1,$2,'active',$3,now())`, [otherBrand, actor, grantor]);
  const role = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
    VALUES($1,'brand','REN2-67 disposable role',false) RETURNING id`, [`ren2_67_${suffix}`])).rows[0].id;
  const permission = (await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description)
    VALUES('catalog.write','catalog','write','REN2-67 integration') ON CONFLICT(permission_code) DO UPDATE
    SET permission_code=EXCLUDED.permission_code RETURNING id`)).rows[0].id;
  await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [role, permission]);
  for (const user of [actor, revokedActor]) await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
    VALUES($1,$2,$3,'brand',now(),$4)`, [user, role, brand, grantor]);
  await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
    VALUES($1,$2,$3,'brand',now(),$4)`, [actor, role, otherBrand, grantor]);
  await pool.query(`UPDATE brands.brand_memberships SET membership_state='revoked',row_version=row_version+1,updated_at=now()
    WHERE brand_id=$1 AND user_id=$2`, [brand, revokedActor]);

  // QC rows in the publication fixture must satisfy the global checker policy added by REN2-72.
  const reviewPermission = (await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description)
    VALUES('catalog.review','catalog','review','REN2-67 QC fixture') ON CONFLICT(permission_code) DO UPDATE
    SET permission_code=EXCLUDED.permission_code RETURNING id`)).rows[0].id;
  const reviewRole = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
    VALUES($1,'global','REN2-67 QC fixture',false) RETURNING id`, [`ren2_67_qc_${suffix}`])).rows[0].id;
  await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2)', [reviewRole, reviewPermission]);
  await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,scope_type,active_from,granted_by_id)
    VALUES($1,$2,'global',now(),$3)`, [reviewer, reviewRole, grantor]);

  const categoryId = (await pool.query(`INSERT INTO catalogue.categories(code,name) VALUES($1,'REN2-67 test') RETURNING id`, [`ren2-67-${suffix}`])).rows[0].id;
  await pool.query(`INSERT INTO catalogue.category_schema_versions(category_id,version,ruleset_sha256,validator_version)
    VALUES($1,1,repeat('a',64),'ren2-67-test')`, [categoryId]);
  const product = async (brandId, name) => (await pool.query(`INSERT INTO catalogue.products
    (brand_id,category_id,style_code,title,category_schema_version) VALUES($1,$2,$3,$4,1) RETURNING id`,
  [brandId, categoryId, `REN2-${name}-${suffix}`, name])).rows[0].id;
  const parent = await product(brand, 'Parent'); const otherParent = await product(brand, 'OtherParent');
  const otherBrandProduct = await product(otherBrand, 'OtherBrand');
  const variant = async (productId, sku) => (await pool.query(`INSERT INTO catalogue.product_variants
    (brand_id,product_id,sku,option_signature,options) VALUES($1,$2,$3,$4,'{}'::jsonb) RETURNING id`,
  [brand, productId, sku, sku])).rows[0].id;
  const parentVariant = await variant(parent, `P-${suffix.slice(0, 14)}`);
  const otherProductVariant = await variant(otherParent, `Q-${suffix.slice(0, 14)}`);

  async function createAsset(assetBrand, label, clean = true) {
    const id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO media.media_assets
        (id,brand_id,storage_key,sha256,mime_type,width,height,scan_state,rights_state,derivative_state,file_name,byte_length,
         completed_at,rights_attested_by,rights_attested_at)
        VALUES($1,$2,$3,$4,'image/webp',800,800,$5,$6,$7,$8,32,$9,$10,$11)`,
      [id, assetBrand, `ren2-67/${label}/${id}`, clean ? randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64) : null,
        clean ? 'CLEAN' : 'PENDING', clean ? 'ATTESTED' : 'UNVERIFIED', clean ? 'READY' : 'PENDING', `${label}.webp`,
        clean ? new Date() : null, clean ? actor : null, clean ? new Date() : null]);
      if (clean) for (const kind of ['PREVIEW','THUMBNAIL']) await client.query(`INSERT INTO media.media_derivatives
        (brand_id,media_asset_id,derivative_kind,storage_key,sha256,mime_type,byte_length,width,height)
        VALUES($1,$2,$3,$4,$5,'image/webp',16,400,400)`,
      [assetBrand, id, kind, `ren2-67/${label}/${id}/${kind.toLowerCase()}`, 'b'.repeat(64)]);
      await client.query('COMMIT');
      return id;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  const hero = await createAsset(brand, 'hero'); const gallery = await createAsset(brand, 'gallery');
  const variantAsset = await createAsset(brand, 'variant'); const foreignAsset = await createAsset(otherBrand, 'foreign');
  const pendingAsset = await createAsset(brand, 'pending', false);
  const repository = new ProductMediaPostgresRepository({ pool });
  const context = (key) => ({ brandId: brand, userId: actor, permission: 'catalog.write', requestId: `ren2-67:${key}`, idempotencyKey: key });

  await assert.rejects(repository.attach(parent,
    { mediaAssetId: hero, variantId: null, displayRole: 'gallery', displayOrder: 0, altText: '' },
    { ...context(`revoked-${suffix}`), userId: revokedActor }), expectCode('PRODUCT_MEDIA_PRODUCT_NOT_FOUND'));
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM media.product_media WHERE product_id=$1', [parent])).rows[0].count, 0,
    'a revoked brand member cannot write a link');
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM media.product_media_audit_events WHERE product_id=$1', [parent])).rows[0].count, 0,
    'a denied write creates no audit or partial association');

  await assert.rejects(repository.attach(parent, { mediaAssetId: hero, variantId: otherProductVariant, displayRole: 'gallery', displayOrder: 0, altText: '' }, context(`wrong-variant-${suffix}`)),
    expectCode('PRODUCT_MEDIA_VARIANT_MISMATCH'));
  await assert.rejects(repository.attach(parent, { mediaAssetId: foreignAsset, variantId: null, displayRole: 'gallery', displayOrder: 0, altText: '' }, context(`foreign-${suffix}`)),
    expectCode('PRODUCT_MEDIA_NOT_FOUND'));
  await assert.rejects(repository.attach(parent, { mediaAssetId: pendingAsset, variantId: null, displayRole: 'gallery', displayOrder: 0, altText: '' }, context(`pending-${suffix}`)),
    expectCode('PRODUCT_MEDIA_ASSET_NOT_READY'));

  const firstInput = { mediaAssetId: hero, variantId: null, displayRole: 'gallery', displayOrder: 0, altText: 'Front' };
  const firstKey = `attach-hero-${suffix}`;
  const first = await repository.attach(parent, firstInput, context(firstKey));
  assert.equal(first.displayOrder, 0);
  assert.deepEqual(await repository.attach(parent, firstInput, context(firstKey)), first, 'same key and payload replay returns the original result');
  const second = await repository.attach(parent,
    { mediaAssetId: gallery, variantId: null, displayRole: 'gallery', displayOrder: 1, altText: 'Side' }, context(`attach-gallery-${suffix}`));
  assert.equal(second.displayOrder, 1);
  const variantLink = await repository.attach(parent,
    { mediaAssetId: variantAsset, variantId: parentVariant, displayRole: 'variant', displayOrder: 0, altText: 'Blue' }, context(`attach-variant-${suffix}`));
  assert.equal(variantLink.variantId, parentVariant);
  await assert.rejects(repository.attach(otherBrandProduct,
    { mediaAssetId: foreignAsset, variantId: null, displayRole: 'gallery', displayOrder: 0, altText: '' },
  { ...context(`other-brand-${suffix}`), brandId: brand }), expectCode('PRODUCT_MEDIA_PRODUCT_NOT_FOUND'));

  const reorderVersion = Number((await pool.query('SELECT row_version FROM catalogue.products WHERE id=$1', [parent])).rows[0].row_version);
  const updated = await repository.update(parent, second.id, { displayOrder: 0, altText: 'Side updated' }, reorderVersion, context(`update-${suffix}`));
  assert.equal(updated.displayOrder, 0, 'display order zero is the target primary image');
  assert.equal(updated.displayOrder, 0);
  const reorderedFirst = (await pool.query('SELECT display_order FROM media.product_media WHERE id=$1', [first.id])).rows[0];
  assert.equal(reorderedFirst.display_order, 1, 'reordering the primary image shifts its sibling without changing the immutable asset association');
  const reorderAudit = (await pool.query(`SELECT before_snapshot,after_snapshot FROM media.product_media_audit_events
    WHERE request_id=$1`, [`ren2-67:update-${suffix}`])).rows[0];
  assert.deepEqual(reorderAudit.before_snapshot.links.map((link) => [link.id, link.displayOrder, link.altText]),
    [[first.id, 0, 'Front'], [second.id, 1, 'Side']]);
  assert.deepEqual(reorderAudit.after_snapshot.links.map((link) => [link.id, link.displayOrder, link.altText]),
    [[second.id, 0, 'Side updated'], [first.id, 1, 'Front']],
    'the immutable event records collateral gallery reorder and alt-text changes');
  assert.deepEqual(await repository.update(parent, second.id, { displayOrder: 0, altText: 'Side updated' }, reorderVersion, context(`update-${suffix}`)), updated,
    'an exact mutation retry returns the saved receipt');
  await assert.rejects(repository.update(parent, second.id, { displayOrder: 1 }, reorderVersion, context(`stale-${suffix}`)),
    expectCode('PRODUCT_MEDIA_VERSION_CONFLICT'));
  const raceVersion = Number((await pool.query('SELECT row_version FROM catalogue.products WHERE id=$1', [parent])).rows[0].row_version);
  const racingUpdates = await Promise.allSettled([
    repository.update(parent, second.id, { displayOrder: 0 }, raceVersion, context(`race-a-${suffix}`)),
    repository.update(parent, second.id, { displayOrder: 0 }, raceVersion, context(`race-b-${suffix}`)),
  ]);
  assert.equal(racingUpdates.filter((result) => result.status === 'fulfilled').length, 1,
    'only one concurrent mutation can commit for a product row version');
  assert.equal(racingUpdates.filter((result) => result.status === 'rejected' && result.reason.code === 'PRODUCT_MEDIA_VERSION_CONFLICT').length, 1,
    'the second concurrent mutation observes the committed version and receives a conflict');

  const snapshot = { mediaLinks: [{ linkId: first.id, mediaAssetId: hero, variantId: null, displayOrder: 1, displayRole: 'gallery', altText: 'Front' }] };
  const revision = (await pool.query(`INSERT INTO catalogue.product_revisions
    (brand_id,product_id,content_version,content_snapshot,content_sha256,submitted_by,review_state,category_id,category_schema_version)
    VALUES($1,$2,1,$3::jsonb,$4,$5,'SUBMITTED',$6,1) RETURNING id`,
  [brand, parent, JSON.stringify(snapshot), 'c'.repeat(64), actor, categoryId])).rows[0].id;
  const approval = (await pool.query(`INSERT INTO catalogue.product_qc_reviews
    (brand_id,product_id,revision_id,reviewer_user_id,decision,reason_code)
    VALUES($1,$2,$3,$4,'APPROVED','REN2_67_TEST') RETURNING id`, [brand, parent, revision, reviewer])).rows[0].id;
  await pool.query(`UPDATE catalogue.products SET publication_state='PUBLISHED',qc_state='APPROVED',published_revision_id=$2,
    published_approval_id=$3,published_approval_decision='APPROVED' WHERE id=$1 AND brand_id=$4`, [parent, revision, approval, brand]);

  // Simulate legacy/corrupt association data to prove publication revalidates the live asset state.
  // Only the isolated cloned test database has its insert guard disabled for this fixture.
  await pool.query('ALTER TABLE media.product_media DISABLE TRIGGER product_media_asset_ready_guard');
  let invalidLinkId;
  try {
    invalidLinkId = (await pool.query(`INSERT INTO media.product_media
      (brand_id,product_id,media_asset_id,display_role,display_order,alt_text)
      VALUES($1,$2,$3,'legacy-invalid',2,'') RETURNING id`, [brand, parent, pendingAsset])).rows[0].id;
  } finally {
    await pool.query('ALTER TABLE media.product_media ENABLE TRIGGER product_media_asset_ready_guard');
  }
  const nextRevision = (await pool.query(`INSERT INTO catalogue.product_revisions
    (brand_id,product_id,content_version,content_snapshot,content_sha256,submitted_by,review_state,category_id,category_schema_version)
    VALUES($1,$2,2,$3::jsonb,$4,$5,'SUBMITTED',$6,1) RETURNING id`,
  [brand, parent, JSON.stringify(snapshot), 'd'.repeat(64), actor, categoryId])).rows[0].id;
  const nextApproval = (await pool.query(`INSERT INTO catalogue.product_qc_reviews
    (brand_id,product_id,revision_id,reviewer_user_id,decision,reason_code)
    VALUES($1,$2,$3,$4,'APPROVED','REN2_67_REVALIDATION_TEST') RETURNING id`, [brand, parent, nextRevision, reviewer])).rows[0].id;
  await assert.rejects(pool.query(`UPDATE catalogue.products SET publication_state='PUBLISHED',qc_state='APPROVED',
    published_revision_id=$2,published_approval_id=$3,published_approval_decision='APPROVED' WHERE id=$1`,
  [parent, nextRevision, nextApproval]), (error) => error.code === '23514' && /PRODUCT_MEDIA_ASSET_NOT_READY/.test(error.message));
  await pool.query('DELETE FROM media.product_media WHERE id=$1', [invalidLinkId]);

  const detachVersion = Number((await pool.query('SELECT row_version FROM catalogue.products WHERE id=$1', [parent])).rows[0].row_version);
  const detached = await repository.detach(parent, first.id, detachVersion, context(`detach-${suffix}`));
  assert.equal(detached.status, 'DETACHED'); assert.equal(detached.rowVersion, detachVersion + 1);
  assert.deepEqual(await repository.detach(parent, first.id, detachVersion, context(`detach-${suffix}`)), detached,
    'detaching can be replayed idempotently');
  const linkAfterDetach = (await pool.query('SELECT detached_at,media_asset_id FROM media.product_media WHERE id=$1', [first.id])).rows[0];
  assert.ok(linkAfterDetach.detached_at); assert.equal(linkAfterDetach.media_asset_id, hero, 'the original link and licensed asset remain stored');
  const detachAudit = (await pool.query(`SELECT before_snapshot,after_snapshot FROM media.product_media_audit_events
    WHERE request_id=$1`, [`ren2-67:detach-${suffix}`])).rows[0];
  assert.equal(detachAudit.before_snapshot.links.length, 2);
  assert.deepEqual(detachAudit.after_snapshot.links.map((link) => link.id), [second.id],
    'detach history records the compacted gallery after removing the target');
  const preserved = await pool.query('SELECT content_snapshot FROM catalogue.product_revisions WHERE id=$1', [revision]);
  assert.deepEqual(preserved.rows[0].content_snapshot, snapshot, 'detaching the active link does not mutate the approved revision snapshot');
  const productAfterDetach = await pool.query('SELECT publication_state,published_revision_id,qc_state FROM catalogue.products WHERE id=$1', [parent]);
  assert.equal(productAfterDetach.rows[0].publication_state, 'PUBLISHED'); assert.equal(productAfterDetach.rows[0].published_revision_id, revision);
  assert.equal(productAfterDetach.rows[0].qc_state, 'NOT_SUBMITTED', 'the prior published revision remains while the new draft needs review');
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM media.product_media_audit_events WHERE product_id=$1', [parent])).rows[0].count, 6);
});
