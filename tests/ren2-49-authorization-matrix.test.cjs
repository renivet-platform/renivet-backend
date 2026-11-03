const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

test('REN2-49 maps all 44 candidate operations to a permission and authorization lane', () => {
  const matrix = readFileSync('docs/security/ren2-49-w1-w2-identity-permission-reconciliation.md', 'utf8');
  const rows = matrix.split(/\r?\n/).filter((line) => /^\|\s*\d+\s*\|/.test(line));
  assert.equal(rows.length, 44);

  const operationIds = [];
  for (const row of rows) {
    const columns = row.split('|').slice(1, -1).map((column) => column.trim());
    assert.equal(columns.length, 6, `expected six columns in ${row}`);
    operationIds.push(columns[2].replaceAll('`', ''));
    assert.match(columns[3].replaceAll('`', ''), /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);
    assert.match(columns[4], /^(brand|platform-global-admin)(?:\s|$)/);
    assert.notEqual(columns[5], '', 'every operation needs a role mapping or explicit UNMAPPED status');
  }
  assert.equal(new Set(operationIds).size, 44, 'operation IDs must be unique');
  assert.equal(rows.filter((row) => row.includes('| platform-global-admin |')).length, 2,
    'taxonomy operations use the separate platform-global guard lane');
});
