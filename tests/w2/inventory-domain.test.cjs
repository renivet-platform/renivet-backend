'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateAvailableToSell, validateBalance, needsIndependentApproval } = require('../../dist/modules/inventory/inventory-domain.js');

test('REN2-83 calculates ATS from the five stock buckets and never returns a negative value', () => {
  assert.equal(calculateAvailableToSell({ physical: 20, quarantine: 1, committed: 4, allocated: 2, buffer: 3 }), 10);
  assert.equal(calculateAvailableToSell({ physical: 3, quarantine: 0, committed: 3, allocated: 2, buffer: 0 }), 0);
});

test('REN2-83 rejects negative buckets and physical stock below quarantine plus commitments', () => {
  assert.throws(() => validateBalance({ physical: 4, quarantine: 2, committed: 3, allocated: 0, buffer: 0 }), { code: 'STOCK_BALANCE_INVALID' });
  assert.throws(() => validateBalance({ physical: 2, quarantine: -1, committed: 0, allocated: 0, buffer: 0 }), { code: 'STOCK_BALANCE_INVALID' });
});

test('REN2-87 requires independent review for adjustments over either configured threshold', () => {
  const policy = { absoluteUnits: 10, percentage: 50, version: 'D05-v1' };
  assert.equal(needsIndependentApproval(10, 100, policy), false);
  assert.equal(needsIndependentApproval(11, 100, policy), true);
  assert.equal(needsIndependentApproval(2, 3, policy), true);
});
