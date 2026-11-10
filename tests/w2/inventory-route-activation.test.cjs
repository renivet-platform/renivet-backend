'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('REN2-83..89 inventory controllers stay dormant until G07/G08/G17 authorize activation', () => {
  const appModule = readFileSync(path.join(root, 'src/app.module.ts'), 'utf8');
  const activeApi = JSON.parse(readFileSync(path.join(root, 'openapi/renivet.openapi.json'), 'utf8'));
  assert.doesNotMatch(appModule, /InventoryModule/);
  assert.equal(Object.keys(activeApi.paths).some((route) => route.includes('/inventory/')), false);
});
