'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { shouldStageForCatalogEdit, mayWritePrivateDraft } = require('../../dist/modules/imports/import-staging-policy.js');

test('all validation/review/conflict outcomes remain accepted source records', () => {
  for (const action of ['INVALID', 'NEEDS_REVIEW', 'CONFLICT', 'UNKNOWN']) {
    assert.equal(shouldStageForCatalogEdit(action), true, action);
    assert.equal(mayWritePrivateDraft(action), false, action);
  }
});

test('valid catalog rows can be written privately without an import approval gate', () => {
  for (const action of ['CREATE', 'UPDATE']) {
    assert.equal(shouldStageForCatalogEdit(action), false);
    assert.equal(mayWritePrivateDraft(action), true);
  }
  assert.equal(shouldStageForCatalogEdit('NOOP'), false);
  assert.equal(mayWritePrivateDraft('NOOP'), false);
});
