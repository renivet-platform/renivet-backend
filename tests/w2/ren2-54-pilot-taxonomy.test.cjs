'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const fixturePath = join(__dirname, '../../src/modules/catalog/taxonomy/apparel-pilot-v1.json');

test('REN2-54 pilot taxonomy has the owner-approved categories, typed vocabularies and safe compliance boundary', () => {
  const dataset = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(dataset.datasetId, 'renivet.catalog-taxonomy.apparel-pilot-v1');
  assert.equal(dataset.version, 1);
  assert.match(dataset.parentCategories[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(dataset.owner, 'Catalog Operations');
  assert.deepEqual(dataset.categories.map(({ code }) => code), [
    't_shirts_tops', 'shirts_blouses', 'kurtas_tunics', 'dresses_jumpsuits',
    'trousers_jeans', 'skirts_shorts', 'jackets_outerwear', 'activewear',
  ]);
  assert.equal(new Set(dataset.categories.map(({ code }) => code)).size, dataset.categories.length);
  assert.equal(new Set(dataset.categories.map(({ id }) => id)).size, dataset.categories.length);
  const sharedAttributeIds = new Map();
  for (const category of dataset.categories) {
    assert.match(category.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(category.parentCode, 'apparel');
    assert.equal(category.leaf, true);
    const byCode = Object.fromEntries(category.attributes.map((attribute) => [attribute.code, attribute]));
    for (const required of ['size', 'color', 'material_composition', 'fit', 'care_instructions']) {
      assert.ok(byCode[required], `${category.code} must define ${required}`);
    }
    for (const code of ['size', 'color', 'fit', 'care_instructions']) {
      assert.ok(Array.isArray(byCode[code].allowedValues) && byCode[code].allowedValues.length > 0, `${category.code}.${code} needs controlled values`);
    }
    assert.equal(byCode.material_composition.valueType, 'text');
    assert.ok(Array.isArray(byCode.material_composition.fiberVocabulary) && byCode.material_composition.fiberVocabulary.length > 0);
    for (const attribute of category.attributes) {
      assert.match(attribute.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      if (sharedAttributeIds.has(attribute.code)) assert.equal(attribute.id, sharedAttributeIds.get(attribute.code));
      else sharedAttributeIds.set(attribute.code, attribute.id);
      assert.ok(['product', 'variant'].includes(attribute.scope), `${category.code}.${attribute.code} must be typed and scoped`);
      assert.ok(['text', 'integer', 'decimal', 'boolean', 'enum', 'multi_enum', 'measurement'].includes(attribute.valueType));
      if (attribute.valueType === 'measurement') assert.equal(attribute.unitCode, 'cm');
    }
  }
  assert.deepEqual(dataset.compliance.rules, []);
  assert.equal(dataset.compliance.policy, 'existing-w2-policy-only');
  assert.match(dataset.compliance.publishGate, /fail closed/i);
});
