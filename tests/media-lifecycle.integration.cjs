'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const test = require('node:test');
const { Pool } = require('pg');
const { MediaPostgresRepository, MediaRepositoryError } = require('../dist/modules/media/media.repository.js');
const { MediaService } = require('../dist/modules/media/media.service.js');

const url = process.env.RENIVET_TEST_DATABASE_URL;
function assertDisposable(value) {
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required for REN2-66 PostgreSQL integration tests');
  const parsed = new URL(value);
  assert.equal(parsed.protocol, 'postgresql:');
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, '/renivet_ci');
  assert.equal(parsed.username, 'renivet_ci');
}

test('REN2-66 persists idempotent brand-owned media lifecycle and requires private derivatives before CLEAN', {
  skip: !url && 'requires the disposable PostgreSQL 16 database', timeout: 60_000,
}, async (t) => {
  assertDisposable(url);
  const pool = new Pool({ connectionString: url, max: 6 });
  t.after(() => pool.end());
  const version = await pool.query('SHOW server_version_num');
  assert.ok(Number(version.rows[0].server_version_num) >= 160000 && Number(version.rows[0].server_version_num) < 170000);
  const lifecycleConstraints = await pool.query(`SELECT conname, convalidated FROM pg_constraint
    WHERE conrelid='media.media_assets'::regclass AND conname IN
      ('media_assets_hashes_valid','media_assets_clean_requires_hash_and_derivatives')`);
  assert.equal(lifecycleConstraints.rows.length, 2);
  assert.ok(lifecycleConstraints.rows.every((constraint) => constraint.convalidated === false),
    'new lifecycle constraints protect new writes without rejecting pre-existing W2 design rows');

  const suffix = randomUUID().replaceAll('-', '');
  const makeUser = async (name) => (await pool.query(
    `INSERT INTO identity.users(email,display_name,state) VALUES($1,$2,'active') RETURNING id`,
    [`ren2-66-${name}-${suffix}@example.invalid`, name])).rows[0].id;
  const actorId = await makeUser('media-editor');
  const grantorId = await makeUser('media-grantor');
  const roleId = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
    VALUES($1,'brand','REN2-66 disposable media role',false) RETURNING id`, [`ren2_66_${suffix}`])).rows[0].id;
  const brandId = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
    VALUES($1,'REN2-66 Synthetic','REN2-66 Synthetic','approved') RETURNING id`, [`ren2-66-${suffix}`])).rows[0].id;
  const otherBrandId = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
    VALUES($1,'REN2-66 Other','REN2-66 Other','approved') RETURNING id`, [`ren2-66-other-${suffix}`])).rows[0].id;
  await pool.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at)
    VALUES($1,$2,'active',$3,now())`, [brandId, actorId, grantorId]);
  const existingMediaGrants = await pool.query(`SELECT count(*)::int AS count FROM access.role_permissions rp
    JOIN access.permissions p ON p.id=rp.permission_id JOIN access.roles r ON r.id=rp.role_id
    WHERE p.permission_code='media.write' AND r.is_system=true`);
  assert.equal(existingMediaGrants.rows[0].count, 0, 'the migration creates no default system-role grants for media.write');
  const permissions = {};
  for (const [code, resource, action] of [['media.write','media','write'], ['catalog.write','catalog','write'], ['catalog.read','catalog','read']]) {
    const row = await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description)
      VALUES($1,$2,$3,'REN2-66 test permission') ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code RETURNING id`, [code, resource, action]);
    permissions[code] = row.rows[0].id;
    await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [roleId, permissions[code]]);
  }
  await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
    VALUES($1,$2,$3,'brand',now(),$4)`, [actorId, roleId, brandId, grantorId]);

  const repository = new MediaPostgresRepository({ pool });
  const uploadKey = `media-upload-${suffix}`;
  const access = { brandId, userId: actorId, permission: 'media.write', requestId: `r66:${suffix}`, idempotencyKey: uploadKey };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==', 'base64');
  const sha256 = createHash('sha256').update(png).digest('hex');
  const request = { fileName: 'front.png', mimeType: 'image/png', byteLength: png.length, rightsAttested: true, sha256 };
  const create = { assetId: randomUUID(), storageKey: `brands/${brandId}/media/temp/original`,
    uploadKey: `brands/${brandId}/media/temp/incoming/${suffix}`, request, requestSha256: 'a'.repeat(64), context: access };
  const pending = await repository.createIntent(create);
  const replay = await repository.createIntent({ ...create, assetId: randomUUID(), uploadKey: `brands/${brandId}/media/ignored` });
  assert.equal(replay.id, pending.id, 'same request key and payload replay the original asset');
  assert.equal(replay.rowVersion, pending.rowVersion + 1, 'renewing the upload expiry advances its row version');
  await assert.rejects(repository.createIntent({ ...create, requestSha256: 'b'.repeat(64) }),
    (error) => error instanceof MediaRepositoryError && error.code === 'MEDIA_IDEMPOTENCY_CONFLICT');

  const storage = {
    isConfigured: () => true,
    async createUploadIntent() { return { uploadUrl: 'https://private.example/signed', expiresAt: pending.uploadExpiresAt, headers: {} }; },
    async headObject() { return { contentLength: png.length, contentType: 'image/png', metadata: { 'renivet-brand-id': brandId, 'renivet-media-asset-id': pending.id } }; },
    async readObject() { return png; },
    async putPrivateObject() {}, async createPreviewUrl() { return 'https://private.example/preview'; }, async deleteObject() {},
  };
  const scanner = { isConfigured: () => true, async scan() { return 'CLEAN'; } };
  const processor = { async createDerivatives() { return [
    { kind: 'PREVIEW', key: `brands/${brandId}/media/${pending.id}/derivatives/preview.webp`, bytes: Buffer.from('preview'), sha256: 'c'.repeat(64), width: 1, height: 1, mimeType: 'image/webp' },
    { kind: 'THUMBNAIL', key: `brands/${brandId}/media/${pending.id}/derivatives/thumbnail.webp`, bytes: Buffer.from('thumbnail'), sha256: 'd'.repeat(64), width: 1, height: 1, mimeType: 'image/webp' },
  ]; } };
  const service = new MediaService(repository, storage, scanner, processor);
  const completionContext = { ...access, permission: 'catalog.write', requestId: `complete:${suffix}`, idempotencyKey: `complete-${suffix}` };
  const receipt = await service.complete(pending.id, { sha256, sizeBytes: png.length }, completionContext);
  assert.equal(receipt.status, 'CLEAN');
  const status = await service.status(pending.id, { ...access, permission: 'catalog.read' });
  assert.equal(status.scanState, 'CLEAN');
  assert.equal(status.rightsState, 'ATTESTED');
  assert.equal(status.derivativeState, 'READY');
  assert.equal(status.safePreviewUrl, 'https://private.example/preview');
  const derivatives = await pool.query('SELECT derivative_kind, brand_id FROM media.media_derivatives WHERE media_asset_id=$1 ORDER BY derivative_kind', [pending.id]);
  assert.deepEqual(derivatives.rows.map((row) => row.derivative_kind), ['PREVIEW','THUMBNAIL']);
  assert.ok(derivatives.rows.every((row) => row.brand_id === brandId));

  await assert.rejects(repository.getStatus(pending.id, { ...access, brandId: otherBrandId, permission: 'catalog.read' }),
    (error) => error instanceof MediaRepositoryError && error.status === 404, 'cross-brand access is non-disclosing');
  const audit = await pool.query('SELECT event_name FROM media.upload_audit_events WHERE media_asset_id=$1 ORDER BY created_at,id', [pending.id]);
  assert.deepEqual(audit.rows.map((row) => row.event_name), ['upload_intent_issued','upload_cleaned']);
  await assert.rejects(pool.query('UPDATE media.upload_audit_events SET reason_code=NULL WHERE media_asset_id=$1', [pending.id]),
    /MEDIA_UPLOAD_AUDIT_IMMUTABLE/);

  const unsafe = await repository.createIntent({
    ...create, assetId: randomUUID(), storageKey: `brands/${brandId}/media/unscanned/original`,
    uploadKey: `brands/${brandId}/media/unscanned/incoming/${suffix}`,
    requestSha256: 'e'.repeat(64), context: { ...access, idempotencyKey: `unscanned-${suffix}` },
  });
  await assert.rejects(pool.query(`UPDATE media.media_assets SET scan_state='CLEAN',derivative_state='READY',sha256=$2,
    completed_at=now(),row_version=row_version+1 WHERE id=$1`, [unsafe.id, sha256]), /MEDIA_CLEAN_REQUIRES_PREVIEW_AND_THUMBNAIL/);
});
