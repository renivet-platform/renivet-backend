'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseCatalogCsv } = require('../../dist/modules/imports/import-csv-parser.js');

test('REN2-76 parses UTF-8 CSV as data and does not evaluate formula-like cells', () => {
  const result = parseCatalogCsv({ sourceKind: 'GENERIC_CSV', bytes: Buffer.from('SKU,Title,Color\nA-1,"T-shirt – café",Blue\nA-2,=1+1,Red\n') });
  assert.equal(result.catalogRows[0].title, 'T-shirt – café');
  assert.equal(result.catalogRows[1].title, '=1+1');
  assert.deepEqual(result.rowErrors, []);
});

test('REN2-76 isolates malformed CSV rows and enforces the 5,000-row limit', () => {
  const malformed = parseCatalogCsv({ sourceKind: 'GENERIC_CSV', bytes: Buffer.from('SKU,Title\n,Missing key\nOK,Valid\n') });
  assert.deepEqual(malformed.rowErrors, [{ sourceRowNumber: 2, code: 'IMPORT_ROW_REQUIRED_FIELD' }]);
  const csv = `SKU,Title\n${Array.from({ length: 5_001 }, (_, i) => `SKU-${i},Product ${i}`).join('\n')}`;
  assert.throws(() => parseCatalogCsv({ sourceKind: 'GENERIC_CSV', bytes: Buffer.from(csv) }), { code: 'IMPORT_ROW_LIMIT_EXCEEDED' });
});

test('REN2-76 rejects invalid UTF-8, malformed quoting, and duplicate headers', () => {
  assert.throws(() => parseCatalogCsv({ sourceKind: 'GENERIC_CSV', bytes: Buffer.from([0xff, 0xfe]) }), { code: 'IMPORT_CSV_ENCODING_INVALID' });
  assert.throws(() => parseCatalogCsv({ sourceKind: 'GENERIC_CSV', bytes: Buffer.from('SKU,Title\n1,"broken') }), { code: 'IMPORT_CSV_INVALID' });
  assert.throws(() => parseCatalogCsv({ sourceKind: 'GENERIC_CSV', bytes: Buffer.from('SKU,SKU\n1,2') }), { code: 'IMPORT_CSV_HEADER_INVALID' });
});

test('REN2-76 parses quoted delimiters and UTF-8 split across parser chunks', () => {
  const prefix = 'SKU,Title\nA-1,"';
  // Place the first quote of an escaped pair at the end of the 32 KiB chunk.
  const padding = 'x'.repeat(32 * 1024 - Buffer.byteLength(prefix) - 1);
  const bytes = Buffer.from(`${prefix}${padding}""é, shirt"\n`);
  const result = parseCatalogCsv({ sourceKind: 'GENERIC_CSV', bytes });
  assert.equal(result.catalogRows[0].title, `${padding}"é, shirt`);
});
