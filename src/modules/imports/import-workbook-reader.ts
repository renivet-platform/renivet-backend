import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as unzipper from 'unzipper';
import { Readable } from 'node:stream';
import { WorkbookCell, WorkbookSheet } from './import-format-profiles';

export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_XLSX_EXPANDED_BYTES = 100 * 1024 * 1024;
export const MAX_XLSX_ENTRIES = 1_000;
export const MAX_IMPORT_ROWS = 5_000;
export const MAX_WORKBOOK_ROWS = 50_000;

export class ImportWorkbookError extends Error {
  constructor(readonly code: string) { super('The source file could not be safely read.'); this.name = 'ImportWorkbookError'; }
}

function cellValue(value: unknown): WorkbookCell {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  // Do not evaluate formulas, hyperlinks, rich text or embedded objects as imported data.
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text;
  return '';
}

async function verifyZipContainer(bytes: Buffer): Promise<void> {
  let directory: unzipper.CentralDirectory;
  try { directory = await unzipper.Open.buffer(bytes); }
  catch { throw new ImportWorkbookError('IMPORT_FILE_INVALID'); }
  if (directory.files.length > MAX_XLSX_ENTRIES) throw new ImportWorkbookError('IMPORT_FILE_LIMIT_EXCEEDED');
  let expanded = 0;
  let actualExpanded = 0;
  for (const entry of directory.files) {
    if (entry.path.startsWith('/') || entry.path.split(/[\\/]/).includes('..') || /\.(?:vbaProject\.bin|bin)$/i.test(entry.path)) {
      throw new ImportWorkbookError('IMPORT_FILE_UNSUPPORTED');
    }
    expanded += Number(entry.uncompressedSize ?? 0);
    if (expanded > MAX_XLSX_EXPANDED_BYTES) throw new ImportWorkbookError('IMPORT_FILE_LIMIT_EXCEEDED');
    if (entry.type === 'Directory') continue;
    try {
      for await (const chunk of entry.stream()) {
        actualExpanded += chunk.length;
        if (actualExpanded > MAX_XLSX_EXPANDED_BYTES) {
          throw new ImportWorkbookError('IMPORT_FILE_LIMIT_EXCEEDED');
        }
      }
    } catch (error) {
      if (error instanceof ImportWorkbookError) throw error;
      throw new ImportWorkbookError('IMPORT_FILE_INVALID');
    }
  }
  if (!directory.files.some((entry) => entry.path === '[Content_Types].xml')
      || !directory.files.some((entry) => entry.path === 'xl/workbook.xml')) {
    throw new ImportWorkbookError('IMPORT_FILE_INVALID');
  }
}

export async function readXlsxWorkbook(bytes: Buffer): Promise<WorkbookSheet[]> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_IMPORT_FILE_BYTES) {
    throw new ImportWorkbookError('IMPORT_FILE_LIMIT_EXCEEDED');
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ImportWorkbookError('IMPORT_FILE_INVALID');
  await verifyZipContainer(bytes);
  // ExcelJS currently misses some valid workbooks whose root workbook element
  // uses a namespace prefix. Normalize that single XML document in memory.
  let parserBytes = bytes;
  let sheetNames: string[] = [];
  try {
    const archive = await JSZip.loadAsync(bytes);
    let normalizedNamespace = false;
    for (const [name, entry] of Object.entries(archive.files)) {
      if (entry.dir || !name.endsWith('.xml')) continue;
      const xml = await entry.async('string');
      if (name === 'xl/workbook.xml') {
        sheetNames = [...xml.matchAll(/<(?:x:)?sheet\b[^>]*\bname=(['"])(.*?)\1/g)]
          .map((match) => match[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
      }
      const normalized = xml.replace(/(<\/?\s*)x:/g, '$1')
        .replace(/\s+xmlns:x="[^"]*"/g, '')
        // Excel tables duplicate metadata about cells already present in the
        // worksheet grid. Ignore the metadata; import only explicit cell data.
        .replace(/<tableParts\b[^>]*>[\s\S]*?<\/tableParts>/g, '')
        .replace(/<tableParts\b[^>]*\/>/g, '');
      if (normalized !== xml) {
        archive.file(name, normalized);
        normalizedNamespace = true;
      }
    }
    if (normalizedNamespace) parserBytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  } catch { throw new ImportWorkbookError('IMPORT_FILE_INVALID'); }
  const sheets: WorkbookSheet[] = [];
  let totalRows = 0;
  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([Buffer.from(parserBytes) as never]),
      { sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore' });
    let sheetIndex = 0;
    for await (const worksheet of reader) {
    const rows: WorkbookCell[][] = [];
    const rowNumbers: number[] = [];
    for await (const row of worksheet) {
      totalRows += 1;
      if (totalRows > MAX_WORKBOOK_ROWS) throw new ImportWorkbookError('IMPORT_ROW_LIMIT_EXCEEDED');
      const rowValues = Array.isArray(row.values) ? row.values : [];
      rows.push(rowValues.slice(1).map((value) => cellValue(value)));
      rowNumbers.push(row.number);
    }
    sheets.push({ name: sheetNames[sheetIndex] ?? `Sheet${sheetIndex + 1}`, rows, rowNumbers });
    sheetIndex += 1;
    }
  } catch (error) {
    if (error instanceof ImportWorkbookError) throw error;
    // Some valid producers place worksheet ZIP entries before workbook.xml,
    // which ExcelJS's streaming reader cannot resolve. Retain a bounded
    // document fallback for those archives after the ZIP preflight above.
    sheets.length = 0;
    totalRows = 0;
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(Buffer.from(parserBytes) as never); }
    catch { throw new ImportWorkbookError('IMPORT_FILE_INVALID'); }
    workbook.eachSheet((worksheet) => {
      const rows: WorkbookCell[][] = [];
      const rowNumbers: number[] = [];
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        totalRows += 1;
        if (totalRows > MAX_WORKBOOK_ROWS) throw new ImportWorkbookError('IMPORT_ROW_LIMIT_EXCEEDED');
        const rowValues = Array.isArray(row.values) ? row.values : [];
        rows.push(rowValues.slice(1).map((value) => cellValue(value)));
        rowNumbers.push(row.number);
      });
      sheets.push({ name: worksheet.name, rows, rowNumbers });
    });
  }
  if (sheets.length === 0) throw new ImportWorkbookError('IMPORT_FILE_INVALID');
  return sheets;
}
