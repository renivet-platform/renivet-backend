'use strict';

require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const { TaxonomyAdminController } = require('../../dist/modules/catalog/taxonomy-admin.controller.js');
const { REQUIRE_PLATFORM_PERMISSION } = require('../../dist/modules/access/platform-permission.guard.js');
const { REQUIRE_MFA_ACTION } = require('../../dist/common/guards/require-mfa.js');
const { PlatformPermissionGuard } = require('../../dist/modules/access/platform-permission.guard.js');
const { MfaGuard } = require('../../dist/common/guards/require-mfa.js');

test('taxonomy draft and publish routes require separate global permissions and fresh MFA guards', () => {
  const proposal = TaxonomyAdminController.prototype.propose;
  const publication = TaxonomyAdminController.prototype.publish;
  assert.equal(Reflect.getMetadata(REQUIRE_PLATFORM_PERMISSION, proposal), 'taxonomy.manage');
  assert.equal(Reflect.getMetadata(REQUIRE_MFA_ACTION, proposal), 'taxonomy.manage');
  assert.equal(Reflect.getMetadata(REQUIRE_PLATFORM_PERMISSION, publication), 'taxonomy.approve');
  assert.equal(Reflect.getMetadata(REQUIRE_MFA_ACTION, publication), 'taxonomy.approve');
  assert.deepEqual(Reflect.getMetadata('__guards__', proposal), [PlatformPermissionGuard, MfaGuard]);
  assert.deepEqual(Reflect.getMetadata('__guards__', publication), [PlatformPermissionGuard, MfaGuard]);
});

test('taxonomy mutation controller only accepts the approved proposal and publication operations', () => {
  assert.deepEqual(Object.getOwnPropertyNames(TaxonomyAdminController.prototype).filter((name) => name !== 'constructor' && !name.startsWith('mutationContext') && name !== 'one').sort(), ['propose', 'publish']);
});
