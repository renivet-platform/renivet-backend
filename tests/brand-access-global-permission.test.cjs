const assert = require('node:assert/strict');
const test = require('node:test');
const { BrandAccessRepository } = require('../dist/modules/access/brand-access.repository.js');

test('platform permissions require a global grant with no brand scope', async () => {
  const calls = [];
  const repository = new BrandAccessRepository({ pool: { query: async (...args) => {
    calls.push(args);
    return { rowCount: 1 };
  } } });

  assert.equal(await repository.hasGlobalPermission('user-1', 'taxonomy.manage'), true);
  assert.match(calls[0][0], /effective\.scope_type = 'global'/);
  assert.match(calls[0][0], /effective\.brand_id IS NULL/);
  assert.deepEqual(calls[0][1], ['user-1', 'taxonomy.manage']);
});

test('brand scoped grants do not satisfy platform permission checks', async () => {
  const repository = new BrandAccessRepository({ pool: { query: async () => ({ rowCount: 0 }) } });
  assert.equal(await repository.hasGlobalPermission('user-1', 'taxonomy.manage'), false);
});
