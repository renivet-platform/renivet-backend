'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
require('reflect-metadata');
const { MfaGuard, REQUIRE_MFA_ACTION } = require('../dist/common/guards/require-mfa');
const { PlatformPermissionGuard } = require('../dist/modules/access/platform-permission.guard');
const { InventoryAdminController } = require('../dist/modules/inventory/inventory-admin.controller');

test('inventory approval routes retain platform authorization and have an explicit MFA policy action', () => {
  for (const methodName of ['decideAdjustment', 'decideReturn']) {
    const handler = InventoryAdminController.prototype[methodName];
    assert.equal(Reflect.getMetadata(REQUIRE_MFA_ACTION, handler), 'inventory.adjust.approve');
    assert.deepEqual(Reflect.getMetadata('__guards__', handler), [PlatformPermissionGuard, MfaGuard]);
  }
});
