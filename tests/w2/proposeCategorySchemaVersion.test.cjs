'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildCategorySchemaDiff,
  normalizeCategorySchemaProposal,
} = require('../../dist/modules/catalog/taxonomy-admin.service.js');

const attributeId = 'c080b92a-fb86-4360-9b55-c79b402227df';

function proposal(overrides = {}) {
  return {
    categoryId: '19f234c6-280a-4b51-9e6f-836f44d2f49d',
    version: 1,
    validatorVersion: 'w2-attribute-validator-v1',
    ruleset: { attributes: [{ attributeId, code: 'material', scope: 'product', valueType: 'enum', allowedValues: ['cotton', 'linen'] }] },
    ...overrides,
  };
}

test('taxonomy proposal normalizes and compiles a complete typed ruleset for the requested schema version', () => {
  const result = normalizeCategorySchemaProposal(proposal());
  assert.equal(result.categoryId, proposal().categoryId);
  assert.equal(result.version, 1);
  assert.equal(result.validatorVersion, 'w2-attribute-validator-v1');
  assert.deepEqual(result.rules.map(({ code, scope, valueType, allowedValues }) => ({ code, scope, valueType, allowedValues })), [
    { code: 'material', scope: 'product', valueType: 'enum', allowedValues: ['cotton', 'linen'] },
  ]);
  assert.equal(result.ruleset.attributes.length, 1);
});

test('taxonomy proposal rejects unsupported validators, malformed conditional ASTs and empty schemas', () => {
  const invalid = (error) => error?.getResponse?.().code === 'CATEGORY_SCHEMA_INVALID';
  assert.throws(() => normalizeCategorySchemaProposal(proposal({ validatorVersion: 'eval-v9' })), invalid);
  assert.throws(() => normalizeCategorySchemaProposal(proposal({ ruleset: { attributes: [] } })), invalid);
  assert.throws(() => normalizeCategorySchemaProposal(proposal({ ruleset: { attributes: [{ attributeId, code: 'material', scope: 'product', valueType: 'text' }], injected: true } })), invalid);
  assert.throws(() => normalizeCategorySchemaProposal(proposal({ ruleset: { attributes: [{
    attributeId, code: 'material', scope: 'product', valueType: 'enum', allowedValues: ['cotton'],
    conditionalAst: { version: 1, root: { op: 'exec', code: 'danger' } },
  }] } })), invalid);
});

test('preview ignores non-contract storage identifiers and equivalent optional defaults', () => {
  const before = [{ code: 'material', scope: 'product', valueType: 'text', allowedValues: null, unitCode: null, requiredByDefault: false }];
  const after = [{ attributeId, code: 'material', scope: 'product', valueType: 'text' }];
  assert.deepEqual(buildCategorySchemaDiff(before, after), { added: [], removed: [], changed: [] });
});

test('category schema preview reports deterministic added, removed and changed rules', () => {
  const before = [{ code: 'material', scope: 'product', valueType: 'text', requiredByDefault: false }];
  const after = [
    { code: 'material', scope: 'product', valueType: 'enum', requiredByDefault: true },
    { code: 'size', scope: 'variant', valueType: 'enum', requiredByDefault: false },
  ];
  assert.deepEqual(buildCategorySchemaDiff(before, after), {
    added: [{ code: 'size', scope: 'variant', valueType: 'enum', requiredByDefault: false }],
    removed: [],
    changed: [{
      code: 'material', scope: 'product', before: before[0], after: after[0],
    }],
  });
});
