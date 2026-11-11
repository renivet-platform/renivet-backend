const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const yaml = require('js-yaml');
const test = require('node:test');

test('REN2-49 maps every v1.5 candidate operation to a permission and authorization lane', () => {
  const matrix = readFileSync('docs/security/ren2-49-w1-w2-identity-permission-reconciliation.md', 'utf8');
  const rows = matrix.split(/\r?\n/).filter((line) => /^\|\s*\d+\s*\|/.test(line));
  const candidate = yaml.load(readFileSync('openapi/W2_v1_5_CANDIDATE.yaml', 'utf8'));
  const candidateOperationIds = Object.values(candidate.paths).flatMap((pathItem) => Object.entries(pathItem)
    .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(method.toLowerCase()))
    .map(([, operation]) => operation.operationId));
  assert.equal(candidateOperationIds.length, 47);
  assert.equal(rows.length, candidateOperationIds.length);

  const operationIds = [];
  for (const row of rows) {
    const columns = row.split('|').slice(1, -1).map((column) => column.trim());
    assert.equal(columns.length, 6, `expected six columns in ${row}`);
    operationIds.push(columns[2].replaceAll('`', ''));
    assert.match(columns[3].replaceAll('`', ''), /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);
    assert.match(columns[4], /^(brand|platform-global-admin)(?:\s|$)/);
    assert.notEqual(columns[5], '', 'every operation needs a role mapping or explicit UNMAPPED status');
  }
  assert.equal(new Set(operationIds).size, candidateOperationIds.length, 'operation IDs must be unique');
  assert.deepEqual([...operationIds].sort(), [...candidateOperationIds].sort(), 'every candidate operation must have one matrix row');
  assert.equal(rows.filter((row) => row.includes('| platform-global-admin |')).length, 2,
    'taxonomy operations use the separate platform-global guard lane');
});
