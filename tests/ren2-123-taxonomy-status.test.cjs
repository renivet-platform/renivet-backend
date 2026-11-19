'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TaxonomyAdminPostgresRepository } = require('../dist/modules/catalog/taxonomy-admin.repository.js');

test('REN2-123 admin category reads expose verified published schema and retired state', async () => {
  const current = [{
    id: 'category-1', code: 'shirts', name: 'Shirts', parentId: 'apparel',
    active: false, schemaVersion: 1, isLeaf: true, hasDraft: false, retired: false,
    publishedRuleset: { attributes: [{ code: 'fit', requiredByDefault: true, valueType: 'enum' }] },
  }];
  const repo = new TaxonomyAdminPostgresRepository({
    pool: { query: async (sql) => {
      assert.match(sql, /parent_id AS "parentId"/);
      assert.match(sql, /AS retired/);
      assert.match(sql, /state='PUBLISHED'/);
      assert.match(sql, /AS "publishedRuleset"/);
      assert.match(sql, /category_availability_events/);
      return { rows: current };
    } },
  });
  const result = await repo.listCategories();
  assert.deepEqual(result, current);
  assert.equal(result[0].schemaVersion, 1);
  assert.equal(result[0].active, false);
  assert.equal(result[0].retired, false);
});
