'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash, randomUUID } = require('node:crypto');
const { Pool } = require('pg');

function requireDisposablePostgresUrl() {
  const connection = process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(connection, 'RENIVET_TEST_DATABASE_URL is required for explicit disposable integration tests');

  const address = new URL(connection);
  assert.equal(address.protocol, 'postgresql:', 'Expected a PostgreSQL URL');
  assert.equal(address.hostname, '127.0.0.1', 'Brand/access integration DB must be loopback only');
  assert.equal(address.pathname, '/renivet_ci', 'Brand/access integration DB must be named renivet_ci');
  assert.equal(address.username, 'renivet_ci', 'Only the disposable CI role is permitted');
  return connection;
}

let failureSavepoint = 0;

async function expectConstraintFailure(client, statement, parameters, code, message) {
  const savepoint = `ren2_26_expected_failure_${++failureSavepoint}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await assert.rejects(
      client.query(statement, parameters),
      (error) => error.code === code,
      message,
    );
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
}

test('REN2-26 brand membership, role scopes and permanent audit enforce their database invariants', { timeout: 30000 }, async () => {
  const pool = new Pool({
    connectionString: requireDisposablePostgresUrl(),
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 3000,
  });
  const client = await pool.connect();

  try {
    const version = await client.query('SHOW server_version_num');
    const versionNumber = Number(version.rows[0].server_version_num);
    assert.ok(versionNumber >= 160000 && versionNumber < 170000, 'REN2-26 integration requires disposable PostgreSQL 16');

    const tableRows = await client.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema IN ('brands', 'access') AND table_type = 'BASE TABLE'
      ORDER BY table_schema, table_name
    `);
    const tables = new Set(tableRows.rows.map((row) => `${row.table_schema}.${row.table_name}`));
    for (const tableName of [
      'brands.brands',
      'brands.brand_memberships',
      'access.roles',
      'access.permissions',
      'access.role_permissions',
      'access.role_assignments',
      'access.security_audit_events',
    ]) {
      assert.ok(tables.has(tableName), `REN2-26 requires canonical table ${tableName}`);
    }
    const effectiveView = await client.query(`
      SELECT table_schema, table_name
      FROM information_schema.views
      WHERE table_schema = 'access' AND table_name = 'effective_permissions'
    `);
    assert.equal(effectiveView.rowCount, 1, 'REN2-26 requires a database resolver that filters inactive brand access');

    const columns = await client.query(`
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE (table_schema, table_name) IN (
        ('brands', 'brands'), ('brands', 'brand_memberships'),
        ('access', 'roles'), ('access', 'permissions'),
        ('access', 'role_permissions'), ('access', 'role_assignments'),
        ('access', 'security_audit_events')
      )
      ORDER BY table_schema, table_name, ordinal_position
    `);
    const columnSet = new Set(columns.rows.map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`));
    const expectedColumns = [
      'brands.brands.slug', 'brands.brands.legal_name', 'brands.brands.display_name', 'brands.brands.onboarding_state',
      'brands.brand_memberships.brand_id', 'brands.brand_memberships.user_id', 'brands.brand_memberships.membership_state',
      'brands.brand_memberships.invited_by_id', 'brands.brand_memberships.joined_at',
      'brands.brand_memberships.valid_from', 'brands.brand_memberships.valid_until',
      'access.roles.role_code', 'access.roles.scope_kind', 'access.roles.is_system',
      'access.permissions.permission_code', 'access.permissions.resource', 'access.permissions.action',
      'access.role_permissions.role_id', 'access.role_permissions.permission_id',
      'access.role_assignments.user_id', 'access.role_assignments.role_id', 'access.role_assignments.brand_id',
      'access.role_assignments.scope_type', 'access.role_assignments.active_from',
      'access.role_assignments.active_until', 'access.role_assignments.granted_by_id',
      'access.security_audit_events.actor_user_id', 'access.security_audit_events.action',
      'access.security_audit_events.subject_type', 'access.security_audit_events.subject_id',
      'access.security_audit_events.request_id', 'access.security_audit_events.ip_hash',
      'access.security_audit_events.payload_hash', 'access.security_audit_events.occurred_at',
    ];
    for (const column of expectedColumns) assert.ok(columnSet.has(column), `REN2-26 requires ${column}`);

    const indexRows = await client.query(`
      SELECT schemaname, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname IN ('brands', 'access') AND indexname LIKE 'ren2_26_%'
      ORDER BY indexname
    `);
    const indexDefinitions = new Map(indexRows.rows.map((row) => [row.indexname, row.indexdef]));
    for (const name of [
      'ren2_26_brands_slug_uq',
      'ren2_26_brand_memberships_user_brand_uq',
      'ren2_26_roles_code_uq',
      'ren2_26_roles_id_scope_uq',
      'ren2_26_permissions_code_uq',
      'ren2_26_role_permissions_role_permission_uq',
      'ren2_26_role_assignments_global_uq',
      'ren2_26_role_assignments_brand_uq',
      'ren2_26_security_audit_subject_created_idx',
    ]) assert.ok(indexDefinitions.has(name), `REN2-26 requires reviewed index ${name}`);
    assert.match(indexDefinitions.get('ren2_26_role_assignments_global_uq'), /WHERE \(brand_id IS NULL\)/i);
    assert.match(indexDefinitions.get('ren2_26_role_assignments_brand_uq'), /WHERE \(brand_id IS NOT NULL\)/i);

    const roleRows = await client.query(`
      SELECT r.role_code, r.scope_kind, array_agg(p.permission_code ORDER BY p.permission_code) AS permissions
      FROM access.roles AS r
      LEFT JOIN access.role_permissions AS rp ON rp.role_id = r.id
      LEFT JOIN access.permissions AS p ON p.id = rp.permission_id
      WHERE r.role_code IN ('renivet_admin', 'renivet_support', 'brand_owner', 'brand_staff')
      GROUP BY r.role_code, r.scope_kind
      ORDER BY r.role_code
    `);
    const actualMatrix = Object.fromEntries(roleRows.rows.map((row) => [row.role_code, {
      scope: row.scope_kind,
      permissions: row.permissions.filter((permission) => permission !== null),
    }]));
    assert.deepEqual(actualMatrix, {
      brand_owner: {
        scope: 'brand',
        permissions: [
          'brand_access_audit.read',
          'brand_membership.invite',
          'brand_membership.read',
          'brand_membership.revoke',
          'brand_role.assign_staff',
          'inventory.adjust.propose',
          'inventory.count',
          'inventory.location.manage',
          'inventory.read',
          'inventory.reconcile',
          'inventory.submit',
        ],
      },
      brand_staff: { scope: 'brand', permissions: ['brand_membership.read_self'] },
      renivet_admin: {
        scope: 'global',
        permissions: [
          'access_audit.read',
          'brand_membership.manage',
          'brand_membership.review',
          'inventory.adjust.approve',
          'inventory.read',
          'staff_access.manage',
        ],
      },
      renivet_support: {
        scope: 'global',
        permissions: ['account_status.read', 'brand_status.read'],
      },
    }, 'Only the reviewed first-slice permission matrix is seeded');

    const assignedSeededRoleCount = await client.query(`
      SELECT count(*)::integer AS count
      FROM access.role_assignments AS assignment
      INNER JOIN access.roles AS role ON role.id = assignment.role_id
      WHERE role.role_code IN ('renivet_admin', 'renivet_support', 'brand_owner', 'brand_staff')
    `);
    assert.equal(assignedSeededRoleCount.rows[0].count, 0, 'Seeded role definitions must not grant any user access');

    await client.query('BEGIN');
    const unique = randomUUID().replaceAll('-', '');
    const userIds = [];
    const createUser = async (suffix) => {
      const result = await client.query(
        `INSERT INTO identity.users (email, state)
         VALUES ($1, 'active') RETURNING id`,
        [`ren2-26-${unique}-${suffix}@example.test`],
      );
      userIds.push(result.rows[0].id);
      return result.rows[0].id;
    };
    const ownerId = await createUser('owner');
    const staffId = await createUser('staff');
    const adminId = await createUser('admin');
    const brand = await client.query(
      `INSERT INTO brands.brands (slug, legal_name, display_name, onboarding_state)
       VALUES ($1, 'REN2-26 Synthetic Brand Private Limited', 'Synthetic Brand', 'approved')
       RETURNING id`,
      [`ren2-26-${unique}`],
    );
    const brandId = brand.rows[0].id;

    const membership = await client.query(
      `INSERT INTO brands.brand_memberships (brand_id, user_id, membership_state, invited_by_id, joined_at)
       VALUES ($1, $2, 'active', $3, now()) RETURNING id`,
      [brandId, ownerId, adminId],
    );
    const membershipId = membership.rows[0].id;
    await client.query(
      `INSERT INTO brands.brand_memberships (brand_id, user_id, membership_state)
       VALUES ($1, $2, 'pending')`,
      [brandId, staffId],
    );

    await expectConstraintFailure(
      client,
      `INSERT INTO brands.brand_memberships (brand_id, user_id, membership_state, joined_at)
       VALUES ($1, $2, 'active', now())`,
      [brandId, ownerId],
      '23505',
      'One user cannot hold duplicate membership rows for one brand',
    );
    await expectConstraintFailure(
      client,
      `INSERT INTO brands.brand_memberships (brand_id, user_id, membership_state)
       VALUES ($1, $2, 'pending')`,
      [randomUUID(), staffId],
      '23503',
      'Membership brand IDs must reference the canonical Brand row',
    );
    await expectConstraintFailure(
      client,
      `INSERT INTO brands.brand_memberships (brand_id, user_id, membership_state, joined_at)
       VALUES ($1, $2, 'active', NULL)`,
      [brandId, staffId],
      '23514',
      'Active memberships must have a joined timestamp',
    );
    await expectConstraintFailure(
      client,
      `INSERT INTO brands.brand_memberships (brand_id, user_id, membership_state)
       VALUES ($1, $2, 'unknown')`,
      [brandId, staffId],
      '23514',
      'Unknown membership states must be rejected',
    );
    await expectConstraintFailure(
      client,
      `INSERT INTO brands.brand_memberships (brand_id, user_id, membership_state, valid_from, valid_until)
       VALUES ($1, $2, 'pending', now(), now() - interval '1 minute')`,
      [brandId, staffId],
      '23514',
      'Membership validity windows must be ordered',
    );

    const roles = await client.query(
      `SELECT id, role_code, scope_kind FROM access.roles
       WHERE role_code IN ('renivet_admin', 'brand_owner', 'brand_staff')`,
    );
    const roleByCode = new Map(roles.rows.map((row) => [row.role_code, row]));
    const adminRole = roleByCode.get('renivet_admin');
    const ownerRole = roleByCode.get('brand_owner');
    const staffRole = roleByCode.get('brand_staff');
    assert.ok(adminRole && ownerRole && staffRole, 'Seeded role definitions must be available');

    const globalAssignment = await client.query(
      `INSERT INTO access.role_assignments (user_id, role_id, scope_type, active_from, granted_by_id)
       VALUES ($1, $2, 'global', now(), $3) RETURNING id`,
      [adminId, adminRole.id, adminId],
    );
    const ownerAssignment = await client.query(
      `INSERT INTO access.role_assignments (user_id, role_id, brand_id, scope_type, active_from, granted_by_id)
       VALUES ($1, $2, $3, 'brand', now(), $4) RETURNING id`,
      [ownerId, ownerRole.id, brandId, adminId],
    );
    await client.query(
      `INSERT INTO access.role_assignments (user_id, role_id, brand_id, scope_type, active_from, granted_by_id)
       VALUES ($1, $2, $3, 'brand', now(), $4)`,
      [staffId, staffRole.id, brandId, adminId],
    );

    const ownerGrantId = ownerAssignment.rows[0].id;
    const roleAuditPayload = (action) => JSON.stringify({
      action,
      roleCode: 'brand_owner',
      scopeType: 'brand',
      brandId,
      subjectUserId: ownerId,
    });
    const writeRoleAudit = async (action) => {
      const payload = roleAuditPayload(action);
      return client.query(
        `INSERT INTO access.security_audit_events
          (actor_user_id, action, subject_type, subject_id, request_id, ip_hash, payload_hash, occurred_at)
         VALUES ($1, $2, 'role_assignment', $3, $4, $5, $6, now()) RETURNING id`,
        [adminId, action, ownerGrantId, `ren2-28-${unique}-${action}`, 'c'.repeat(64), createHash('sha256').update(payload).digest('hex')],
      );
    };
    const grantAudit = await writeRoleAudit('role_assignment.granted');
    const assertOwnerInvitePermission = async (expected, reason) => {
      const effective = await client.query(
        `SELECT permission_code FROM access.effective_permissions
         WHERE user_id = $1 AND brand_id = $2 AND permission_code = 'brand_membership.invite'`,
        [ownerId, brandId],
      );
      assert.equal(effective.rowCount, expected ? 1 : 0, reason);
    };
    await assertOwnerInvitePermission(true, 'An active Brand Owner on an approved brand has assigned permissions');
    await client.query('UPDATE access.role_assignments SET active_from = now() - interval \'2 seconds\', active_until = now() - interval \'1 second\' WHERE id = $1', [ownerGrantId]);
    const revokeAudit = await writeRoleAudit('role_assignment.revoked');
    await assertOwnerInvitePermission(false, 'Expired role assignments are not effective');
    await client.query('UPDATE access.role_assignments SET active_until = NULL, active_from = now() + interval \'1 day\' WHERE id = $1', [ownerGrantId]);
    await assertOwnerInvitePermission(false, 'Future role assignments are not effective');
    await client.query('UPDATE access.role_assignments SET active_from = now() WHERE id = $1', [ownerGrantId]);
    await client.query("UPDATE identity.users SET state = 'disabled' WHERE id = $1", [ownerId]);
    await assertOwnerInvitePermission(false, 'Inactive user accounts do not resolve permissions');
    await client.query("UPDATE identity.users SET state = 'active' WHERE id = $1", [ownerId]);
    await client.query("UPDATE brands.brand_memberships SET membership_state = 'suspended' WHERE id = $1", [membershipId]);
    await assertOwnerInvitePermission(false, 'Suspended memberships do not grant permissions');
    await client.query("UPDATE brands.brand_memberships SET membership_state = 'active', valid_from = now() - interval '2 seconds', valid_until = now() - interval '1 second' WHERE id = $1", [membershipId]);
    await assertOwnerInvitePermission(false, 'Expired memberships do not grant permissions');
    await client.query("UPDATE brands.brand_memberships SET valid_until = NULL, membership_state = 'pending' WHERE id = $1", [membershipId]);
    await assertOwnerInvitePermission(false, 'Pending memberships do not grant permissions');
    await client.query("UPDATE brands.brand_memberships SET membership_state = 'active' WHERE id = $1", [membershipId]);
    await client.query("UPDATE brands.brands SET onboarding_state = 'pending' WHERE id = $1", [brandId]);
    await assertOwnerInvitePermission(false, 'Unapproved brands do not grant permissions');
    await client.query("UPDATE brands.brands SET onboarding_state = 'approved' WHERE id = $1", [brandId]);
    await assertOwnerInvitePermission(true, 'Restoring approved state restores the still-valid brand permission');
    const regrant = await client.query(
      `UPDATE access.role_assignments
       SET active_from = now(), active_until = NULL, updated_at = now(), row_version = row_version + 1
       WHERE id = $1 RETURNING id`,
      [ownerGrantId],
    );
    assert.equal(regrant.rows[0].id, ownerGrantId, 'Regranting reopens the durable assignment row; history stays in append-only audit');

    const globalRole = await client.query(
      `SELECT permission_code FROM access.effective_permissions
       WHERE user_id = $1 AND scope_type = 'global' AND brand_id IS NULL AND permission_code = 'brand_membership.manage'`,
      [adminId],
    );
    assert.equal(globalRole.rowCount, 1, 'Active Renivet-wide assignments resolve with global scope');
    await client.query('UPDATE access.role_assignments SET active_from = now() - interval \'2 seconds\', active_until = now() - interval \'1 second\' WHERE id = $1', [globalAssignment.rows[0].id]);
    const expiredGlobalRole = await client.query(
      `SELECT permission_code FROM access.effective_permissions
       WHERE user_id = $1 AND scope_type = 'global' AND permission_code = 'brand_membership.manage'`,
      [adminId],
    );
    assert.equal(expiredGlobalRole.rowCount, 0, 'Expired global assignments are not effective');

    await expectConstraintFailure(
      client,
      `INSERT INTO access.role_assignments (user_id, role_id, brand_id, scope_type, active_from, granted_by_id)
       VALUES ($1, $2, $3, 'global', now(), $4)`,
      [adminId, adminRole.id, brandId, adminId],
      '23514',
      'Global grants cannot carry a brand ID',
    );
    await expectConstraintFailure(
      client,
      `INSERT INTO access.role_assignments (user_id, role_id, scope_type, active_from, granted_by_id)
       VALUES ($1, $2, 'brand', now(), $3)`,
      [ownerId, ownerRole.id, adminId],
      '23514',
      'Brand grants require a brand ID',
    );
    await expectConstraintFailure(
      client,
      `INSERT INTO access.role_assignments (user_id, role_id, scope_type, active_from, granted_by_id)
       VALUES ($1, $2, 'global', now(), $3)`,
      [ownerId, ownerRole.id, adminId],
      '23503',
      'Role scope must match the role definition scope',
    );
    await expectConstraintFailure(
      client,
      `INSERT INTO access.role_assignments (user_id, role_id, brand_id, scope_type, active_from, granted_by_id)
       VALUES ($1, $2, $3, 'brand', now(), $4)`,
      [adminId, ownerRole.id, brandId, adminId],
      '23503',
      'A brand role assignment must reference that principal’s membership in that brand',
    );
    await expectConstraintFailure(
      client,
      `INSERT INTO access.role_assignments (user_id, role_id, scope_type, active_from, active_until, granted_by_id)
       VALUES ($1, $2, 'global', now(), now() - interval '1 second', $3)`,
      [adminId, adminRole.id, adminId],
      '23514',
      'Role assignment validity windows must be ordered',
    );
    await expectConstraintFailure(
      client,
      `INSERT INTO access.role_assignments (user_id, role_id, scope_type, active_from, granted_by_id)
       VALUES ($1, $2, 'global', now(), $3)`,
      [adminId, adminRole.id, adminId],
      '23505',
      'Duplicate role grants in one global scope must be rejected',
    );

    const event = await client.query(
      `INSERT INTO access.security_audit_events
         (actor_user_id, action, subject_type, subject_id, request_id, ip_hash, payload_hash, occurred_at)
       VALUES ($1, 'brand_membership.approved', 'brand_membership', $2, $3, $4, $5, now())
       RETURNING id`,
      [adminId, membershipId, `ren2-26-${unique}`, 'b'.repeat(64), 'a'.repeat(64)],
    );
    const auditId = event.rows[0].id;
    await expectConstraintFailure(
      client,
      'UPDATE access.security_audit_events SET action = $1 WHERE id = $2',
      ['tampered', auditId],
      '55000',
      'Access audit events must reject updates',
    );
    await expectConstraintFailure(
      client,
      'DELETE FROM access.security_audit_events WHERE id = $1',
      [auditId],
      '55000',
      'Access audit events must reject deletion',
    );
    const retained = await client.query(
      'SELECT action, subject_id FROM access.security_audit_events WHERE id = $1',
      [auditId],
    );
    assert.equal(retained.rows[0].action, 'brand_membership.approved');
    assert.equal(retained.rows[0].subject_id, membershipId);

    const roleAudit = await client.query(
      `SELECT action, subject_type, subject_id, request_id, ip_hash, payload_hash
       FROM access.security_audit_events WHERE id = ANY($1::uuid[]) ORDER BY action`,
      [[grantAudit.rows[0].id, revokeAudit.rows[0].id]],
    );
    assert.deepEqual(roleAudit.rows.map((row) => row.action), ['role_assignment.granted', 'role_assignment.revoked']);
    assert.ok(roleAudit.rows.every((row) => row.subject_type === 'role_assignment' && row.subject_id === ownerGrantId));
    assert.ok(roleAudit.rows.every((row) => /^[0-9a-f]{64}$/.test(row.ip_hash) && /^[0-9a-f]{64}$/.test(row.payload_hash)));
    assert.equal(JSON.stringify(roleAudit.rows).includes(`${unique}-owner@example.test`), false, 'Access audit contains no raw user email');

    await expectConstraintFailure(
      client,
      `INSERT INTO access.security_audit_events
        (action, subject_type, request_id, payload_hash, occurred_at)
       VALUES ('bad action', 'brand_membership', $1, $2, now())`,
      [`ren2-26-${unique}-bad`, 'not-a-sha256-digest'],
      '23514',
      'Audit action and payload hash must follow safe formats',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
