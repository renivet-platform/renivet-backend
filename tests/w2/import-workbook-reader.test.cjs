'use strict';

const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const test = require('node:test');
const { readXlsxWorkbook, MAX_IMPORT_FILE_BYTES } = require('../../dist/modules/imports/import-workbook-reader.js');

test('REN2-76 reads cell values without evaluating spreadsheet formulas', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('MASTER DATA');
  sheet.addRow(['UNIQUE PRODUCT CODE', 'STYLE NAME', 'Inventory']);
  sheet.addRow(['SKU-1', 'Shirt', 4]);
  sheet.addRow(['SKU-2', 'Shirt', { formula: '1+1', result: 2 }]);
  const parsed = await readXlsxWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal(parsed[0].rows[1][1], 'Shirt');
  assert.equal(parsed[0].rows[2][2], '');
});

test('REN2-76 rejects oversized, non-XLSX, and structurally invalid source files', async () => {
  await assert.rejects(readXlsxWorkbook(Buffer.alloc(MAX_IMPORT_FILE_BYTES + 1)), { code: 'IMPORT_FILE_LIMIT_EXCEEDED' });
  await assert.rejects(readXlsxWorkbook(Buffer.from('not a workbook')), { code: 'IMPORT_FILE_INVALID' });
  await assert.rejects(readXlsxWorkbook(Buffer.from([0x50, 0x4b, 0x03, 0x04])), { code: 'IMPORT_FILE_INVALID' });
});
