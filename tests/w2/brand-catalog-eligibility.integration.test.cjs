'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { BrandCatalogEligibilityPostgresRepository } = require('../../dist/modules/identity/brand-catalog-eligibility.repository.js');

const url = process.env.RENIVET_TEST_DATABASE_URL;
const code = (expected) => (error) => error?.code === expected;

test('REN2-55 applies W1 approval outcomes atomically, idempotently, and through current global reviewer permissions', {
  skip: url ? false : 'requires disposable PostgreSQL 16', timeout: 60_000,
}, async (t) => {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'postgresql:');
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.username, 'renivet_ci');
  assert.equal(parsed.pathname, '/renivet_ci');
  const pool = new Pool({ connectionString: url, max: 6 });
  t.after(() => pool.end());
  const version = Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 160000 && version < 170000, 'REN2-55 requires disposable PostgreSQL 16');

  const suffix = randomUUID().replaceAll('-', '');
  const addUser = async (label) => (await pool.query(
    `INSERT INTO identity.users(email,display_name,state) VALUES($1,$2,'active') RETURNING id`,
    [`ren2-55-${label}-${suffix}@example.invalid`, `REN2-55 ${label}`],
  )).rows[0].id;
  const approver = await addUser('approver');
  const checker = await addUser('checker');
  const unauthorized = await addUser('unauthorized');
  const applicant = await addUser('applicant');
  const grantor = await addUser('grantor');
  const adminRoleId = (await pool.query("SELECT id FROM access.roles WHERE role_code='renivet_admin' AND scope_kind='global'")).rows[0]?.id;
  const membershipReadId = (await pool.query("SELECT id FROM access.permissions WHERE permission_code='brand_membership.read'")).rows[0]?.id;
  assert.ok(adminRoleId && membershipReadId, 'W1 administrator role and membership permission must exist');
  for (const userId of [approver, checker]) await pool.query(
    `INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
     VALUES($1,$2,NULL,'global',now(),$3)`, [userId, adminRoleId, grantor],
  );

  const brandId = (await pool.query(
    `INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
     VALUES($1,'REN2-55 approved fixture','REN2-55 approved fixture','pending') RETURNING id`, [`ren2-55-approved-${suffix}`],
  )).rows[0].id;
  const role = (await pool.query("SELECT id FROM access.roles WHERE role_code='brand_owner' AND scope_kind='brand'")).rows[0]?.id;
  assert.ok(role, 'existing W1 brand owner role must exist');
  await pool.query(
    `INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id)
     VALUES($1,$2,'pending',$3)`, [brandId, applicant, grantor],
  );
  // New applications have no owner grant before approval. The approval transaction creates it.
  const permissionCountBefore = Number((await pool.query(
    `SELECT count(*)::int AS n FROM access.role_assignments WHERE user_id=$1 AND brand_id=$2`, [applicant, brandId],
  )).rows[0].n);
  assert.equal((await pool.query(
    `SELECT count(*)::int AS n FROM access.effective_permissions
      WHERE user_id=$1 AND brand_id=$2 AND permission_code='brand_membership.read'`, [applicant, brandId],
  )).rows[0].n, 0, 'pending brand and membership must not confer a live W1 permission');

  const repository = new BrandCatalogEligibilityPostgresRepository({ pool });
  const eventId = randomUUID();
  const outcome = { eventId, brandId, applicantUserId: applicant, decision: 'approved',
    approvedByUserId: approver, checkedByUserId: checker, requestId: `req-${suffix}` };
  await assert.rejects(repository.applyOutcome(outcome), code('BRAND_APPROVAL_CHECKER_ATTESTATION_REQUIRED'));
  await pool.query(
    `INSERT INTO brands.brand_application_checker_attestations
      (brand_id,applicant_user_id,checker_user_id,decision,request_id)
      VALUES($1,$2,$3,'approved',$4)`,
    [brandId,applicant,checker,`attest-${suffix}`],
  );
  const concurrentApprovals = await Promise.all([
    repository.applyOutcome(outcome),
    repository.applyOutcome({ ...outcome, requestId: `concurrent-replay-${suffix}` }),
  ]);
  const accepted = concurrentApprovals.find((result) => !result.replayed);
  assert.ok(accepted, 'exactly one concurrent event delivery must perform the state transition');
  assert.equal(concurrentApprovals.filter((result) => result.replayed).length, 1);
  assert.equal(accepted.brandState, 'approved');
  assert.equal(accepted.membershipState, 'active');
  assert.equal(accepted.replayed, false);
  assert.equal((await pool.query('SELECT onboarding_state FROM brands.brands WHERE id=$1', [brandId])).rows[0].onboarding_state, 'approved');
  assert.deepEqual((await pool.query('SELECT membership_state,joined_at IS NOT NULL AS joined FROM brands.brand_memberships WHERE brand_id=$1 AND user_id=$2', [brandId, applicant])).rows[0], { membership_state: 'active', joined: true });
  assert.equal((await pool.query(
    `SELECT count(*)::int AS n FROM access.effective_permissions
      WHERE user_id=$1 AND brand_id=$2 AND permission_code='brand_membership.read'`, [applicant, brandId],
  )).rows[0].n, 1, 'existing assigned W1 permission becomes effective only after approval and joined membership');
  assert.equal(Number((await pool.query(
    `SELECT count(*)::int AS n FROM access.role_assignments
      WHERE user_id=$1 AND brand_id=$2 AND role_id=$3`, [applicant, brandId, role],
  )).rows[0].n), permissionCountBefore + 1, 'approved applicant receives precisely one scoped owner role');

  const replay = await repository.applyOutcome({ ...outcome, requestId: `replay-${suffix}` });
  assert.equal(replay.replayed, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM brands.brand_catalog_eligibility_events WHERE event_id=$1', [eventId])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM access.role_assignments WHERE user_id=$1 AND brand_id=$2', [applicant, brandId])).rows[0].n, 1, 'replay does not duplicate ownership');
  await assert.rejects(repository.applyOutcome({ ...outcome, applicantUserId: grantor }), code('BRAND_APPROVAL_EVENT_CONFLICT'));
  const event = (await pool.query('SELECT event_id FROM brands.brand_catalog_eligibility_events WHERE event_id=$1', [eventId])).rows[0];
  await assert.rejects(pool.query('UPDATE brands.brand_catalog_eligibility_events SET request_id=request_id WHERE event_id=$1', [event.event_id]), /IMMUTABLE/i);

  const rejectedBrand = (await pool.query(
    `INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
     VALUES($1,'REN2-55 rejected fixture','REN2-55 rejected fixture','pending') RETURNING id`, [`ren2-55-rejected-${suffix}`],
  )).rows[0].id;
  await assert.rejects(repository.applyOutcome({ ...outcome, brandId: rejectedBrand }), code('BRAND_APPROVAL_EVENT_CONFLICT'));
  assert.equal((await pool.query('SELECT onboarding_state FROM brands.brands WHERE id=$1', [rejectedBrand])).rows[0].onboarding_state, 'pending', 'cross-brand event replay must not change another brand');
  await pool.query(
    `INSERT INTO brands.brand_application_checker_attestations
      (brand_id,applicant_user_id,checker_user_id,decision,request_id)
      VALUES($1,$2,$3,'rejected',$4)`,
    [rejectedBrand,applicant,checker,`reject-attest-${suffix}`],
  );
  const rejected = await repository.applyOutcome({ eventId: randomUUID(), brandId: rejectedBrand,
    applicantUserId: applicant, decision: 'rejected', approvedByUserId: approver,
    checkedByUserId: checker, requestId: `reject-${suffix}` });
  assert.equal(rejected.brandState, 'rejected');
  assert.equal((await pool.query('SELECT onboarding_state FROM brands.brands WHERE id=$1', [rejectedBrand])).rows[0].onboarding_state, 'rejected');
  await assert.rejects(repository.applyOutcome({ eventId: randomUUID(), brandId: rejectedBrand,
    applicantUserId: applicant, decision: 'approved', approvedByUserId: approver,
    checkedByUserId: checker, requestId: `reopen-${suffix}` }), code('BRAND_STATE_NOT_REVIEWABLE'));

  const suspendedBrand = (await pool.query(
    `INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
     VALUES($1,'REN2-55 suspended fixture','REN2-55 suspended fixture','suspended') RETURNING id`, [`ren2-55-suspended-${suffix}`],
  )).rows[0].id;
  await assert.rejects(repository.applyOutcome({ eventId: randomUUID(), brandId: suspendedBrand,
    applicantUserId: applicant, decision: 'approved', approvedByUserId: approver,
    checkedByUserId: checker, requestId: `suspend-${suffix}` }), code('BRAND_STATE_NOT_REVIEWABLE'));

  const beforeDenied = await pool.query('SELECT onboarding_state FROM brands.brands WHERE id=$1', [brandId]);
  await assert.rejects(repository.applyOutcome({ eventId: randomUUID(), brandId,
    applicantUserId: applicant, decision: 'approved', approvedByUserId: unauthorized,
    checkedByUserId: checker, requestId: `unauthorized-${suffix}` }), code('BRAND_APPROVAL_REVIEWER_DENIED'));
  assert.equal((await pool.query('SELECT onboarding_state FROM brands.brands WHERE id=$1', [brandId])).rows[0].onboarding_state, beforeDenied.rows[0].onboarding_state);
});
