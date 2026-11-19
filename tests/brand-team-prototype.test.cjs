const test = require('node:test');
const assert = require('node:assert/strict');
const { BrandAccessRepository } = require('../dist/modules/access/brand-access.repository.js');
const { BrandMembershipController } = require('../dist/modules/access/brand-membership.controller.js');
const { REQUIRE_BRAND_PERMISSION } = require('../dist/modules/access/brand-access.guard.js');

test('SE-20C team read is protected by explicit brand membership permission', () => {
  assert.equal(Reflect.getMetadata(REQUIRE_BRAND_PERMISSION, BrandMembershipController.prototype.team), 'brand_membership.read');
});

test('SE-20C team query uses supplied authorized brandId, not a browser-controlled member ID', async () => {
  const brandId = '11111111-1111-4111-8111-111111111111';
  const expected = [{userId:'member',memberName:'Sample',memberEmail:'sample@example.test',membershipState:'active',permissions:[{roleCode:'brand_staff',permissionCode:'catalog.read'}]}];
  const pool = { query: async (sql, values) => {
    assert.deepEqual(values,[brandId]);
    assert.match(sql,/FROM brands\.brand_memberships m/);
    assert.match(sql,/JOIN identity\.users u ON u\.id=m\.user_id/);
    assert.match(sql,/m\.brand_id=\$1/);
    assert.match(sql,/m\.valid_until AS "validUntil"/);
    assert.match(sql,/COALESCE\(NULLIF\(btrim\(u\.display_name\), ''\), 'Member'\) AS "memberName"/);
    assert.match(sql,/u\.email AS "memberEmail"/);
    return { rows: expected };
  }};
  const repo = new BrandAccessRepository({pool});
  assert.deepEqual(await repo.listTeamPermissions('requestor',brandId),expected);
});

test('SE-20C membership read fails closed if database is unavailable', async () => {
  const repo = new BrandAccessRepository({pool:null});
  await assert.rejects(repo.listTeamPermissions('requestor','brand'),/Authorization database is unavailable/);
});
