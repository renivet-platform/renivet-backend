const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { BrandAccessGuard, REQUIRE_BRAND_PERMISSION, buildBrandScopePredicate } = require('../dist/modules/access/brand-access.guard.js');
const { PlatformPermissionGuard, REQUIRE_PLATFORM_PERMISSION } = require('../dist/modules/access/platform-permission.guard.js');
const { BrandAccessRepository } = require('../dist/modules/access/brand-access.repository.js');
const { IdentityRepository } = require('../dist/modules/identity/identity.repository.js');
const { SessionService, hashSessionToken } = require('../dist/modules/identity/session.service.js');

const permission = 'brand_membership.read';

function testDatabaseUrl() {
  const value = process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required for disposable integration tests');
  const url = new URL(value);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1', 'Integration database must be loopback only');
  assert.equal(url.pathname, '/renivet_ci');
  assert.equal(url.username, 'renivet_ci');
  return value;
}

function requestContext(cookie, brandId, requestedPermission = permission) {
  const request = {
    headers: { cookie },
    params: { brandId },
    body: { userId: 'forged-user', role: 'renivet_admin', brandId: 'forged-brand' },
    query: { userId: 'forged-user', brandId: 'forged-brand' },
    user: { id: 'forged-user', role: 'renivet_admin' },
  };
  const reflector = { get: (key) => key === REQUIRE_BRAND_PERMISSION ? requestedPermission : undefined };
  return {
    request,
    context: { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => request }) },
  };
}

test('REN2-27/28 derives identity from session and rejects cross-tenant and inactive access across query shapes', { timeout: 30000, skip: !process.env.RENIVET_TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl(), max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 3000 });
  const client = await pool.connect();
  const suffix = randomUUID().replaceAll('-', '');
  const created = { users: [], sessions: [], brands: [], assignments: [] };
  const sessionTokens = new Map();
  const brandIds = {};
  let actorId;
  let multiId;
  let globalId;
  let grantorId;
  let unprivilegedId;

  try {
    const version = await client.query('SHOW server_version_num');
    const versionNumber = Number(version.rows[0].server_version_num);
    assert.ok(versionNumber >= 160000 && versionNumber < 170000, 'REN2-27 integration requires disposable PostgreSQL 16');

    const createUser = async (name) => {
      const result = await client.query(`INSERT INTO identity.users (email, state) VALUES ($1, 'active') RETURNING id`, [`ren2-27-${suffix}-${name}@example.test`]);
      created.users.push(result.rows[0].id);
      return result.rows[0].id;
    };
    actorId = await createUser('single-brand');
    multiId = await createUser('multi-brand');
    globalId = await createUser('global-admin');
    grantorId = await createUser('grantor');
    unprivilegedId = await createUser('unprivileged');

    for (const userId of [actorId, multiId, globalId, unprivilegedId]) {
      const token = randomBytes(32).toString('base64url');
      sessionTokens.set(userId, token);
      const stored = await client.query(
        `INSERT INTO identity.user_sessions (user_id, token_hash, expires_at, absolute_expires_at)
         VALUES ($1, $2, now() + interval '30 minutes', now() + interval '1 day') RETURNING id`,
        [userId, hashSessionToken(token)],
      );
      created.sessions.push(stored.rows[0].id);
    }

    for (const brand of ['a', 'b', 'c']) {
      const result = await client.query(
        `INSERT INTO brands.brands (slug, legal_name, display_name, onboarding_state)
         VALUES ($1, $2, $3, 'approved') RETURNING id`,
        [`ren2-27-${suffix}-${brand}`, `REN2-27 Synthetic ${brand.toUpperCase()} Private Limited`, `Synthetic ${brand.toUpperCase()}`],
      );
      brandIds[brand] = result.rows[0].id;
      created.brands.push(result.rows[0].id);
    }
    const unapproved = await client.query(
      `INSERT INTO brands.brands (slug, legal_name, display_name, onboarding_state)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [`ren2-28-${suffix}-unapproved`, 'REN2-28 Synthetic Pending Private Limited', 'Synthetic Pending'],
    );
    brandIds.unapproved = unapproved.rows[0].id;
    created.brands.push(brandIds.unapproved);

    const ownerRole = await client.query(`SELECT id FROM access.roles WHERE role_code = 'brand_owner'`);
    assert.equal(ownerRole.rowCount, 1, 'REN2-26 role seed must exist');
    const roleId = ownerRole.rows[0].id;
    const adminRole = await client.query(`SELECT id FROM access.roles WHERE role_code = 'renivet_admin'`);
    assert.equal(adminRole.rowCount, 1, 'REN2-26 global administrator role seed must exist');
    const globalGrant = await client.query(
      `INSERT INTO access.role_assignments (user_id, role_id, scope_type, active_from, granted_by_id)
       VALUES ($1, $2, 'global', now(), $3) RETURNING id`,
      [globalId, adminRole.rows[0].id, grantorId],
    );
    created.assignments.push(globalGrant.rows[0].id);
    for (const [userId, brand] of [[actorId, 'a'], [multiId, 'a'], [multiId, 'c']]) {
      await client.query(
        `INSERT INTO brands.brand_memberships (brand_id, user_id, membership_state, invited_by_id, joined_at)
         VALUES ($1, $2, 'active', $3, now())`,
        [brandIds[brand], userId, grantorId],
      );
      const grant = await client.query(
        `INSERT INTO access.role_assignments (user_id, role_id, brand_id, scope_type, active_from, granted_by_id)
         VALUES ($1, $2, $3, 'brand', now(), $4) RETURNING id`,
        [userId, roleId, brandIds[brand], grantorId],
      );
      created.assignments.push(grant.rows[0].id);
    }
    await client.query(
      `INSERT INTO brands.brand_memberships (brand_id, user_id, membership_state, invited_by_id, joined_at)
       VALUES ($1, $2, 'active', $3, now())`,
      [brandIds.unapproved, unprivilegedId, grantorId],
    );
    const unapprovedGrant = await client.query(
      `INSERT INTO access.role_assignments (user_id, role_id, brand_id, scope_type, active_from, granted_by_id)
       VALUES ($1, $2, $3, 'brand', now(), $4) RETURNING id`,
      [unprivilegedId, roleId, brandIds.unapproved, grantorId],
    );
    created.assignments.push(unapprovedGrant.rows[0].id);

    await client.query(`CREATE TEMP TABLE ren2_27_resources (
      id uuid PRIMARY KEY, brand_id uuid NOT NULL, parent_id uuid NULL,
      resource_name text NOT NULL, marker text NOT NULL DEFAULT 'original'
    ) ON COMMIT PRESERVE ROWS`);
    const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID(), nestedA: randomUUID(), nestedB: randomUUID() };
    await client.query(
      `INSERT INTO ren2_27_resources (id, brand_id, parent_id, resource_name) VALUES
        ($1, $2, NULL, 'Alpha catalog item'),
        ($3, $4, NULL, 'Bravo catalog item'),
        ($5, $6, NULL, 'Charlie catalog item'),
        ($7, $2, $1, 'Alpha nested item'),
        ($8, $4, $3, 'Bravo nested item')`,
      [ids.a, brandIds.a, ids.b, brandIds.b, ids.c, brandIds.c, ids.nestedA, ids.nestedB],
    );

    const sessions = new SessionService(new IdentityRepository({ pool }), 'synthetic-brand-access-csrf-key-at-least-32-bytes');
    const accessRepository = new BrandAccessRepository({ pool });
    const platformRequest = (userId, requestedPermission) => {
      const request = { headers: { cookie: `__Host-renivet_session=${sessionTokens.get(userId)}` }, body: { userId: 'forged', role: 'renivet_admin', scope: 'global' } };
      const reflector = { get: (key) => key === REQUIRE_PLATFORM_PERMISSION ? requestedPermission : undefined };
      const context = { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => request }) };
      return { request, context, guard: new PlatformPermissionGuard(reflector, sessions, accessRepository) };
    };
    const brandRoleOnPlatformPermission = platformRequest(actorId, 'brand_membership.read');
    await assert.rejects(brandRoleOnPlatformPermission.guard.canActivate(brandRoleOnPlatformPermission.context), (error) => error.getStatus() === 403,
      'a brand-scoped grant must not authorize a platform action');
    const brandRoleOnTaxonomy = platformRequest(actorId, 'taxonomy.manage');
    await assert.rejects(brandRoleOnTaxonomy.guard.canActivate(brandRoleOnTaxonomy.context), (error) => error.getStatus() === 403,
      'brand membership must not authorize platform taxonomy mutation');
    const actualGlobalGrant = platformRequest(globalId, 'staff_access.manage');
    assert.equal(await actualGlobalGrant.guard.canActivate(actualGlobalGrant.context), true,
      'an explicit global-scope W1 permission is accepted');

    const guard = new BrandAccessGuard({ get: (key) => key === REQUIRE_BRAND_PERMISSION ? permission : undefined }, sessions, accessRepository);
    const authorize = async (userId, brandId, requestedPermission = permission) => {
      const harness = requestContext(`__Host-renivet_session=${sessionTokens.get(userId)}`, brandId, requestedPermission);
      const authorizedGuard = new BrandAccessGuard({ get: (key) => key === REQUIRE_BRAND_PERMISSION ? requestedPermission : undefined }, sessions, accessRepository);
      await authorizedGuard.canActivate(harness.context);
      return harness.request.brandAccess;
    };
    const actorA = await authorize(actorId, brandIds.a);
    const scoped = (alias, context = actorA, first = 1) => buildBrandScopePredicate(alias, context, first);

    // Detail, list, search, count and export: a guessed Brand B ID or filter is invisible to Brand A.
    let predicate = scoped('resource');
    let result = await client.query(`SELECT resource.id FROM ren2_27_resources AS resource WHERE ${predicate.sql} AND resource.id = $4`, [...predicate.parameters, ids.b]);
    assert.equal(result.rowCount, 0, 'Guessed cross-brand detail ID returns no row');
    result = await client.query(`SELECT resource.id FROM ren2_27_resources AS resource WHERE ${predicate.sql} ORDER BY resource.id` , predicate.parameters);
    assert.deepEqual(new Set(result.rows.map((row) => row.id)), new Set([ids.a, ids.nestedA]));
    result = await client.query(
      `SELECT resource.id FROM ren2_27_resources AS resource
       WHERE ${predicate.sql} AND resource.resource_name ILIKE $4
       ORDER BY resource.resource_name DESC LIMIT 1 OFFSET 0`,
      [...predicate.parameters, '%item%'],
    );
    assert.equal(result.rows.length, 1, 'Filtered, sorted and paged results remain tenant-scoped');
    assert.ok(result.rows[0].id === ids.a || result.rows[0].id === ids.nestedA);
    result = await client.query(`SELECT resource.id FROM ren2_27_resources AS resource WHERE ${predicate.sql} AND resource.resource_name ILIKE $4`, [...predicate.parameters, '%Bravo%']);
    assert.equal(result.rowCount, 0, 'Cross-brand search returns no rows');
    result = await client.query(`SELECT count(*)::integer AS count FROM ren2_27_resources AS resource WHERE ${predicate.sql}`, predicate.parameters);
    assert.equal(result.rows[0].count, 2, 'Cross-brand rows do not affect counts');
    result = await client.query(`SELECT resource.id, resource.resource_name FROM ren2_27_resources AS resource WHERE ${predicate.sql} ORDER BY resource.id`, predicate.parameters);
    assert.ok(result.rows.every((row) => row.resource_name.startsWith('Alpha')));
    result = await client.query(`SELECT resource.id, resource.resource_name FROM ren2_27_resources AS resource WHERE ${predicate.sql} AND resource.id = $4`, [...predicate.parameters, ids.b]);
    assert.equal(result.rowCount, 0, 'A guessed Brand B export row is not observable from Brand A');

    const childScope = scoped('child', actorA, 1);
    const parentScope = scoped('parent', actorA, 4);
    result = await client.query(
      `SELECT child.id FROM ren2_27_resources AS child
       JOIN ren2_27_resources AS parent ON parent.id = child.parent_id
       WHERE ${childScope.sql} AND ${parentScope.sql}`,
      [...childScope.parameters, ...parentScope.parameters],
    );
    assert.deepEqual(result.rows.map((row) => row.id), [ids.nestedA], 'Nested parent and child are both independently scoped');
    result = await client.query(
      `SELECT child.id FROM ren2_27_resources AS child
       JOIN ren2_27_resources AS parent ON parent.id = child.parent_id
       WHERE ${childScope.sql} AND ${parentScope.sql} AND child.id = $7`,
      [...childScope.parameters, ...parentScope.parameters, ids.nestedB],
    );
    assert.equal(result.rowCount, 0, 'A guessed nested Brand B ID is not observable from Brand A');

    predicate = scoped('resource');
    result = await client.query(`UPDATE ren2_27_resources AS resource SET marker = 'changed' WHERE ${predicate.sql} AND resource.id = $4 RETURNING resource.id`, [...predicate.parameters, ids.b]);
    assert.equal(result.rowCount, 0, 'Cross-brand bulk mutation changes zero rows');
    const bMarker = await client.query(`SELECT marker FROM ren2_27_resources WHERE id = $1`, [ids.b]);
    assert.equal(bMarker.rows[0].marker, 'original');

    const multiC = await authorize(multiId, brandIds.c);
    const multiScope = scoped('resource', multiC);
    result = await client.query(`SELECT resource.id FROM ren2_27_resources AS resource WHERE ${multiScope.sql}`, multiScope.parameters);
    assert.deepEqual(result.rows.map((row) => row.id), [ids.c], 'Multi-brand user sees only the requested authorized brand');
    const multiA = await authorize(multiId, brandIds.a);
    const multiAScope = scoped('resource', multiA);
    result = await client.query(`SELECT resource.id FROM ren2_27_resources AS resource WHERE ${multiAScope.sql}`, multiAScope.parameters);
    assert.deepEqual(new Set(result.rows.map((row) => row.id)), new Set([ids.a, ids.nestedA]), 'Multi-brand user can also use a separate currently granted brand');
    const multiB = requestContext(`__Host-renivet_session=${sessionTokens.get(multiId)}`, brandIds.b);
    await assert.rejects(guard.canActivate(multiB.context), (error) => error.getStatus() === 403, 'Multi-brand user cannot access an ungranted brand');

    const unapprovedPermissions = await client.query(
      `SELECT 1 FROM access.effective_permissions
       WHERE user_id = $1 AND brand_id = $2 AND permission_code = $3`,
      [unprivilegedId, brandIds.unapproved, permission],
    );
    assert.equal(unapprovedPermissions.rowCount, 0, 'A role assignment cannot make a pending brand effective');
    const unapprovedRequest = requestContext(`__Host-renivet_session=${sessionTokens.get(unprivilegedId)}`, brandIds.unapproved);
    await assert.rejects(guard.canActivate(unapprovedRequest.context), (error) => error.getStatus() === 403, 'Unapproved brand access is denied even with an active membership and role row');

    const forgedAdmin = requestContext(
      `__Host-renivet_session=${sessionTokens.get(unprivilegedId)}`,
      brandIds.a,
      'brand_membership.manage',
    );
    await assert.rejects(
      new BrandAccessGuard({ get: (key) => key === REQUIRE_BRAND_PERMISSION ? 'brand_membership.manage' : undefined }, sessions, accessRepository)
        .canActivate(forgedAdmin.context),
      (error) => error.getStatus() === 403,
      'T-ID-09: an unprivileged account cannot turn forged admin claims into a privileged operation',
    );
    assert.equal(forgedAdmin.request.brandAccess, undefined, 'Denied principals receive no authorized scope context');
    const forgedGrant = await client.query(
      `SELECT count(*)::integer AS count FROM access.role_assignments
       WHERE user_id = $1 AND brand_id = $2`,
      [unprivilegedId, brandIds.a],
    );
    assert.equal(forgedGrant.rows[0].count, 0, 'Denied privileged request leaves role assignments unchanged');

    const globalB = await authorize(globalId, brandIds.b, 'brand_membership.manage');
    const globalScope = scoped('resource', globalB);
    result = await client.query(`SELECT resource.id FROM ren2_27_resources AS resource WHERE ${globalScope.sql}`, globalScope.parameters);
    assert.deepEqual(new Set(result.rows.map((row) => row.id)), new Set([ids.b, ids.nestedB]), 'A global permission applies to requested brand scope');

    // Exercise revocation on a separate connection while an old guard context
    // remains in use. The follow-up request waits on the commit boundary and
    // must re-evaluate permissions in its own fresh READ COMMITTED statement.
    const revokeClient = await pool.connect();
    const concurrentReadClient = await pool.connect();
    try {
      let signalRevocationCommitted;
      const revocationCommitted = new Promise((resolve) => { signalRevocationCommitted = resolve; });
      const revokeConcurrently = async () => {
        try {
          await revokeClient.query('BEGIN');
          await revokeClient.query(
            `UPDATE access.role_assignments
             SET active_from = now() - interval '2 seconds', active_until = now() - interval '1 second',
                 updated_at = now(), row_version = row_version + 1
             WHERE user_id = $1 AND brand_id = $2`,
            [actorId, brandIds.a],
          );
          await revokeClient.query('COMMIT');
        } catch (error) {
          await revokeClient.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          signalRevocationCommitted();
        }
      };
      const staleContextReadAfterCommit = async () => {
        await revocationCommitted;
        return concurrentReadClient.query(
          `SELECT count(*)::integer AS count FROM access.effective_permissions
           WHERE user_id = $1 AND brand_id = $2 AND permission_code = $3`,
          [actorA.userId, actorA.brandId, permission],
        );
      };
      const [, concurrentResult] = await Promise.all([revokeConcurrently(), staleContextReadAfterCommit()]);
      assert.equal(concurrentResult.rows[0].count, 0, 'A concurrent request using the old guard context sees the committed revocation in the live permission view');
    } finally {
      concurrentReadClient.release();
      revokeClient.release();
    }

    // A scope already issued by the guard is not a permission cache: every SQL statement rechecks the view.
    predicate = scoped('resource', actorA);
    result = await client.query(`SELECT count(*)::integer AS count FROM ren2_27_resources AS resource WHERE ${predicate.sql}`, predicate.parameters);
    assert.equal(result.rows[0].count, 0, 'Concurrent grant expiry denies the next statement using an old context');
    result = await client.query(`UPDATE ren2_27_resources AS resource SET marker = 'after-revoke' WHERE ${predicate.sql} RETURNING resource.id`, predicate.parameters);
    assert.equal(result.rowCount, 0, 'Committed revocation blocks writes through old contexts');

    await client.query(`UPDATE access.role_assignments SET active_from = now(), active_until = NULL, updated_at = now(), row_version = row_version + 1 WHERE user_id = $1 AND brand_id = $2`, [actorId, brandIds.a]);
    await client.query(`UPDATE access.role_assignments SET active_until = clock_timestamp(), updated_at = now(), row_version = row_version + 1 WHERE user_id = $1 AND brand_id = $2`, [actorId, brandIds.a]);
    result = await client.query(`SELECT count(*)::integer AS count FROM ren2_27_resources AS resource WHERE ${predicate.sql}`, predicate.parameters);
    assert.equal(result.rows[0].count, 0, 'Explicitly revoked role assignment denies the next statement using an old context');

    await client.query(`UPDATE access.role_assignments SET active_until = NULL, active_from = now(), updated_at = now(), row_version = row_version + 1 WHERE user_id = $1 AND brand_id = $2`, [actorId, brandIds.a]);
    await client.query(`UPDATE brands.brand_memberships SET membership_state = 'suspended' WHERE user_id = $1 AND brand_id = $2`, [actorId, brandIds.a]);
    result = await client.query(`SELECT count(*)::integer AS count FROM ren2_27_resources AS resource WHERE ${predicate.sql}`, predicate.parameters);
    assert.equal(result.rows[0].count, 0, 'Committed membership suspension denies the next statement using an old context');

    await client.query(`UPDATE brands.brand_memberships
                        SET membership_state = 'active', valid_from = now() - interval '2 seconds', valid_until = now() - interval '1 second'
                        WHERE user_id = $1 AND brand_id = $2`, [actorId, brandIds.a]);
    result = await client.query(`SELECT count(*)::integer AS count FROM ren2_27_resources AS resource WHERE ${predicate.sql}`, predicate.parameters);
    assert.equal(result.rows[0].count, 0, 'Expired membership denies the next statement using an old context');

    await client.query(`UPDATE brands.brand_memberships
                        SET membership_state = 'pending', joined_at = NULL, valid_from = now(), valid_until = NULL
                        WHERE user_id = $1 AND brand_id = $2`, [actorId, brandIds.a]);
    result = await client.query(`SELECT count(*)::integer AS count FROM ren2_27_resources AS resource WHERE ${predicate.sql}`, predicate.parameters);
    assert.equal(result.rows[0].count, 0, 'Pending membership denies the next statement using an old context');

    assert.throws(() => buildBrandScopePredicate('resource; DROP TABLE brands.brands', actorA), /safe SQL table alias/);
    assert.throws(() => buildBrandScopePredicate('resource', { ...actorA }), /server-authorized brand context/);
  } finally {
    for (const assignmentId of created.assignments) await client.query('DELETE FROM access.role_assignments WHERE id = $1', [assignmentId]).catch(() => {});
    for (const sessionId of created.sessions) await client.query('DELETE FROM identity.user_sessions WHERE id = $1', [sessionId]).catch(() => {});
    for (const userId of created.users) await client.query('DELETE FROM brands.brand_memberships WHERE user_id = $1', [userId]).catch(() => {});
    for (const brandId of created.brands) await client.query('DELETE FROM brands.brands WHERE id = $1', [brandId]).catch(() => {});
    for (const userId of created.users) await client.query('DELETE FROM identity.users WHERE id = $1', [userId]).catch(() => {});
    client.release();
    await pool.end();
  }
});
