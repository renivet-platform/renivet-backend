'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { BrandAccessGuard, REQUIRE_BRAND_PERMISSION } = require('../../dist/modules/access/brand-access.guard.js');
const { BrandAccessRepository } = require('../../dist/modules/access/brand-access.repository.js');
const { IdentityRepository } = require('../../dist/modules/identity/identity.repository.js');
const { SessionService, hashSessionToken } = require('../../dist/modules/identity/session.service.js');
const { TaxonomyAdminPostgresRepository } = require('../../dist/modules/catalog/taxonomy-admin.repository.js');
const { CatalogReadPostgresRepository } = require('../../dist/modules/catalog/catalog-read.repository.js');

const url = process.env.RENIVET_TEST_DATABASE_URL;
const permission = 'catalog.read';

function databaseUrl() {
  assert.ok(url, 'RENIVET_TEST_DATABASE_URL is required');
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'postgresql:');
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, '/renivet_ci');
  assert.equal(parsed.username, 'renivet_ci');
  return url;
}

async function insertUser(pool, tag) {
  const result = await pool.query(
    `INSERT INTO identity.users(email,display_name,state) VALUES($1,$2,'active') RETURNING id`,
    [`${tag}-${randomUUID()}@example.test`, tag],
  );
  return result.rows[0].id;
}

async function insertCategory(pool, code, parentId = null) {
  const result = await pool.query(
    `INSERT INTO catalogue.categories(code,name,parent_id) VALUES($1,$1,$2) RETURNING id`,
    [code, parentId],
  );
  return result.rows[0].id;
}

function contextFor(userId, brandId) { return { userId, brandId, permission }; }

test('REN2-59 reads the shared tree and exact immutable versions under live brand authorization', {
  skip: !url && 'requires a disposable PostgreSQL 16 service',
  timeout: 60_000,
}, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl(), max: 6, connectionTimeoutMillis: 5_000 });
  t.after(() => pool.end());
  const version = await pool.query('SHOW server_version_num');
  assert.ok(Number(version.rows[0].server_version_num) >= 160000 && Number(version.rows[0].server_version_num) < 170000);

  const suffix = randomUUID().replaceAll('-', '');
  const ownerId = await insertUser(pool, `r59-owner-${suffix}`);
  const grantorId = await insertUser(pool, `r59-grantor-${suffix}`);
  const proposerId = await insertUser(pool, `r59-proposer-${suffix}`);
  const approverId = await insertUser(pool, `r59-approver-${suffix}`);
  const brandResult = await pool.query(
    `INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
     VALUES($1,'REN2-59 Synthetic Ltd','REN2-59 Synthetic','approved') RETURNING id`, [`ren2-59-${suffix}`],
  );
  const brandId = brandResult.rows[0].id;
  const membership = await pool.query(
    `INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at)
     VALUES($1,$2,'active',$3,now()) RETURNING id`, [brandId, ownerId, grantorId],
  );
  const role = await pool.query(
    `INSERT INTO access.roles(role_code,scope_kind,description,is_system)
     VALUES($1,'brand','REN2-59 disposable test role',false) RETURNING id`, [`r59_${suffix.slice(0, 30)}`],
  );
  const permissionRow = await pool.query(
    `INSERT INTO access.permissions(permission_code,resource,action,description)
     VALUES($1,'catalog','read','REN2-59 test permission')
     ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code
     RETURNING id`, [permission],
  );
  await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [role.rows[0].id, permissionRow.rows[0].id]);
  const assignment = await pool.query(
    `INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
     VALUES($1,$2,$3,'brand',now(),$4) RETURNING id`, [ownerId, role.rows[0].id, brandId, grantorId],
  );
  const sessionToken = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO identity.user_sessions(user_id,token_hash,expires_at,absolute_expires_at)
     VALUES($1,$2,now()+interval '30 minutes',now()+interval '1 day')`, [ownerId, hashSessionToken(sessionToken)],
  );

  const sessionService = new SessionService(new IdentityRepository({ pool }), 'ren2-59-synthetic-csrf-hmac-key-with-32-bytes-minimum');
  const brandAccessRepository = new BrandAccessRepository({ pool });
  const reflector = { get: (key) => key === REQUIRE_BRAND_PERMISSION ? permission : undefined };
  const makeAccessContext = async () => {
    const request = { headers: { cookie: `__Host-renivet_session=${sessionToken}` }, params: { brandId } };
    const execution = { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => request }) };
    await new BrandAccessGuard(reflector, sessionService, brandAccessRepository).canActivate(execution);
    return request.brandAccess;
  };
  const access = await makeAccessContext();
  const readRepository = new CatalogReadPostgresRepository({ pool });
  const adminRepository = new TaxonomyAdminPostgresRepository({ pool });
  const rootId = await insertCategory(pool, `r59-root-${suffix}`);
  const leafId = await insertCategory(pool, `r59-leaf-${suffix}`, rootId);
  const attributes = [];
  for (const code of [`r59-material-${suffix}`, `r59-size-${suffix}`]) {
    const row = await pool.query(
      `INSERT INTO catalogue.attributes(code,label,value_type,scope_type,allowed_values)
       VALUES($1,$1,'text','product',NULL) RETURNING id,code`, [code],
    );
    attributes.push({ attributeId: row.rows[0].id, code: row.rows[0].code });
  }
  const rulesFor = (requiredByDefault) => attributes.map((attribute) => ({
    ...attribute, scope: 'product', valueType: 'text', requiredByDefault,
  }));
  const proposalContext = { actorId: proposerId, requestId: `r59:${randomUUID()}`, idempotencyKey: `r59-p1-${randomUUID()}` };
  const versionOne = await adminRepository.propose({
    categoryId: leafId, version: 1, validatorVersion: 'w2-attribute-validator-v1', ruleset: { attributes: rulesFor(false) },
  }, proposalContext);
  await adminRepository.publish({ categoryId: leafId, version: 1 }, { actorId: approverId, requestId: `r59:${randomUUID()}`, idempotencyKey: `r59-pub1-${randomUUID()}` });
  await pool.query('BEGIN');
  await pool.query(
    "SELECT set_config('app.taxonomy_actor_user_id',$1,true), set_config('app.taxonomy_request_id',$2,true), set_config('app.taxonomy_reason_code','INITIAL_ACTIVATION',true)",
    [approverId, `r59:${randomUUID()}`],
  );
  await pool.query('UPDATE catalogue.categories SET active=true WHERE id=$1', [leafId]);
  await pool.query('COMMIT');

  const treeFirst = await readRepository.listCategories(access, null, 1);
  assert.equal(treeFirst.items.length, 1);
  assert.ok(treeFirst.nextCursor);
  const treeAll = [treeFirst.items[0]];
  let cursor = treeFirst.nextCursor;
  while (cursor) {
    const page = await readRepository.listCategories(access, cursor, 1);
    treeAll.push(...page.items);
    cursor = page.nextCursor;
  }
  const root = treeAll.find((item) => item.id === rootId);
  const leaf = treeAll.find((item) => item.id === leafId);
  assert.equal(root.isLeaf, false);
  assert.deepEqual(leaf.pathCodes.slice(-2), [`r59-root-${suffix}`, `r59-leaf-${suffix}`]);
  assert.equal(leaf.currentSchemaVersion, 1);
  assert.equal(leaf.isActive, true);

  const firstAttributes = await readRepository.getCategoryAttributes(access, leafId, null, 1);
  assert.equal(firstAttributes.items.length, 1);
  assert.ok(firstAttributes.nextCursor);
  const pageTwo = await readRepository.getCategoryAttributes(access, leafId, firstAttributes.nextCursor, 1);
  assert.equal(pageTwo.items.length, 1);
  const oldVersion = await readRepository.getCategorySchemaVersion(access, leafId, 1);
  assert.equal(oldVersion.state, 'PUBLISHED');
  assert.equal(oldVersion.attributes.length, 2);
  assert.ok(oldVersion.attributes.every((item) => item.required === false));

  await adminRepository.propose({
    categoryId: leafId, version: 2, validatorVersion: 'w2-attribute-validator-v1', ruleset: { attributes: rulesFor(true) },
  }, { actorId: proposerId, requestId: `r59:${randomUUID()}`, idempotencyKey: `r59-p2-${randomUUID()}` });
  await adminRepository.publish({ categoryId: leafId, version: 2 }, { actorId: approverId, requestId: `r59:${randomUUID()}`, idempotencyKey: `r59-pub2-${randomUUID()}` });
  const currentVersion = await readRepository.getCategoryAttributes(access, leafId, null, 10);
  assert.ok(currentVersion.items.every((item) => item.required === true));
  assert.equal((await readRepository.getCategorySchemaVersion(access, leafId, 1)).attributes.every((item) => item.required === false), true);
  await assert.rejects(readRepository.getCategoryAttributes(access, leafId, firstAttributes.nextCursor, 1), (error) => error.code === 'CATEGORY_CURSOR_VERSION_CHANGED');
  assert.equal(versionOne.status, 'draft_submitted');

  await pool.query('UPDATE brands.brand_memberships SET membership_state=$2 WHERE id=$1', [membership.rows[0].id, 'suspended']);
  await assert.rejects(makeAccessContext(), (error) => error.getStatus?.() === 403);
  await assert.rejects(readRepository.listCategories(access, null, 10), (error) => error.code === 'CATALOG_READ_FORBIDDEN');
  await pool.query('DELETE FROM access.role_assignments WHERE id=$1', [assignment.rows[0].id]);
});
