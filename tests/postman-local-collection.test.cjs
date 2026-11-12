const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createUnauthenticatedLocalCollection } = require('./helpers/local-postman-collection.cjs');

test('local Postman collection copy has no cloud identity and keeps its requests', () => {
  const sourcePath = join(__dirname, '..', 'postman', 'collections', 'renivet-backend-auth.postman_collection.json');
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const tempDir = mkdtempSync(join(tmpdir(), 'renivet-postman-local-'));

  try {
    const localPath = createUnauthenticatedLocalCollection(sourcePath, join(tempDir, 'auth.postman_collection.json'));
    const local = JSON.parse(readFileSync(localPath, 'utf8'));

    assert.equal(local.info._postman_id, undefined);
    assert.deepEqual(local.item, source.item);
    assert.deepEqual(local.variable, source.variable);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
