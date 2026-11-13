const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const migration = readFileSync(
  join(__dirname, '..', 'drizzle', '0033_ren2_84_master_a4_single_allocation_bucket.sql'),
  'utf8',
);

test('REN2-111 migration tolerates the observed missing legacy balance constraint', () => {
  assert.match(
    migration,
    /DROP CONSTRAINT IF EXISTS stock_balances_physical_covers_all_non_sellable_and_commitments/,
  );
  assert.match(migration, /DROP CONSTRAINT stock_balances_physical_covers_quarantine_and_commitments/);
  assert.match(migration, /DROP COLUMN pre_commit_allocations/);
});
