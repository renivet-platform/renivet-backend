import { CatalogImportRow, MappedWorkbook, StockObservation } from './import-format-profiles';
import { MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS } from './import-workbook-reader';

export class ImportCsvError extends Error {
  constructor(readonly code: string) { super('The CSV source file is invalid.'); this.name = 'ImportCsvError'; }
}

function records(bytes: Buffer): string[][] {
  if (bytes.length > MAX_IMPORT_FILE_BYTES) throw new ImportCsvError('IMPORT_FILE_LIMIT_EXCEEDED');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let quoteClosed = false;
  let firstText = true;
  let deferred = '';
  const consume = (part: string, final: boolean) => {
    if (firstText && part.length) { part = part.replace(/^\uFEFF/, ''); firstText = false; }
    if (deferred) { part = deferred + part; deferred = ''; }
    if (!final && part.length && ['"', '\r'].includes(part.at(-1)!)) {
      deferred = part.at(-1)!;
      part = part.slice(0, -1);
    }
    if (part.includes('\0')) throw new ImportCsvError('IMPORT_CSV_INVALID');
    for (let i = 0; i < part.length; i += 1) {
      const ch = part[i];
      if (quoted) {
        if (ch === '"' && part[i + 1] === '"') { field += '"'; i += 1; }
        else if (ch === '"') { quoted = false; quoteClosed = true; }
        else field += ch;
      } else if (quoteClosed && ch !== ',' && ch !== '\n' && ch !== '\r') throw new ImportCsvError('IMPORT_CSV_INVALID');
      else if (ch === '"' && field.length === 0) quoted = true;
      else if (ch === '"') throw new ImportCsvError('IMPORT_CSV_INVALID');
      else if (ch === ',') { row.push(field); field = ''; quoteClosed = false; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && part[i + 1] === '\n') i += 1;
        row.push(field); field = '';
        quoteClosed = false;
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
        if (rows.length > MAX_IMPORT_ROWS + 1) throw new ImportCsvError('IMPORT_ROW_LIMIT_EXCEEDED');
      } else field += ch;
    }
  };
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder('utf-8', { fatal: true });
    const chunkSize = 32 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      consume(decoder.decode(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)), { stream: true }), false);
    }
    consume(decoder.decode(), true);
  } catch (error) {
    if (error instanceof ImportCsvError) throw error;
    throw new ImportCsvError('IMPORT_CSV_ENCODING_INVALID');
  }
  if (deferred) consume(deferred, true);
  if (quoted) throw new ImportCsvError('IMPORT_CSV_INVALID');
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows.length < 2) throw new ImportCsvError('IMPORT_CSV_HEADER_INVALID');
  if (rows.length > MAX_IMPORT_ROWS + 1) throw new ImportCsvError('IMPORT_ROW_LIMIT_EXCEEDED');
  return rows;
}

function sourceNumber(value: string): number | undefined {
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parseCatalogCsv(input: { bytes: Buffer; sourceKind: string }): MappedWorkbook {
  const [headersRow, ...data] = records(input.bytes);
  const headers = headersRow.map((value) => value.trim().toLowerCase());
  if (headers.some((value) => !value) || new Set(headers).size !== headers.length) throw new ImportCsvError('IMPORT_CSV_HEADER_INVALID');
  if (!headers.some((value) => ['sku','variant sku','sku code','uniquesku','unique product code'].includes(value))
    || !headers.some((value) => ['title','name','style name','product name'].includes(value))) {
    throw new ImportCsvError('IMPORT_CSV_HEADER_INVALID');
  }
  const find = (row: string[], names: string[]) => {
    const index = headers.findIndex((header) => names.includes(header));
    return index < 0 ? '' : (row[index] ?? '').trim();
  };
  const catalogRows: CatalogImportRow[] = [];
  const catalogRowNumbers: number[] = [];
  const stockObservations: StockObservation[] = [];
  const rowErrors: Array<{ sourceRowNumber: number; code: string }> = [];
  const rawRows = data.map((row, index) => ({ sourceRowNumber: index + 2,
    rawRecord: Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ''])) }));
  for (const [index, row] of data.entries()) {
    const sku = find(row, ['sku','variant sku','sku code','uniquesku','unique product code']);
    const title = find(row, ['title','name','style name','product name']);
    if (!sku || !title) { rowErrors.push({ sourceRowNumber: index + 2, code: 'IMPORT_ROW_REQUIRED_FIELD' }); continue; }
    const sourceProductKey = find(row, ['handle','shopify handle','product id','productid']) || null;
    const catalog: CatalogImportRow = { sourceRecordKey: sku, sourceProductKey, title, sku, options: {}, attributes: {} };
    const color = find(row, ['color','colour','option1 value']);
    const size = find(row, ['size','option2 value']);
    if (color) catalog.options.color = color;
    if (size) catalog.options.size = size;
    const ean = find(row, ['barcode','ean']);
    if (ean) catalog.attributes.ean = ean;
    const price = sourceNumber(find(row, ['variant price','price','mrp','maximum retail price']));
    if (price !== undefined) catalog.sourceMrp = price;
    const image = find(row, ['image src','image link','image url']);
    if (/^https:\/\//i.test(image)) catalog.sourceImageUrl = image;
    catalogRows.push(catalog);
    catalogRowNumbers.push(index + 2);
    const inventory = sourceNumber(find(row, ['inventory','quantity','stock']));
    if (inventory !== undefined && inventory >= 0) stockObservations.push({ sourceRecordKey: sku, quantity: inventory });
  }
  if (catalogRows.length > MAX_IMPORT_ROWS) throw new ImportCsvError('IMPORT_ROW_LIMIT_EXCEEDED');
  const adapter = input.sourceKind === 'SHOPIFY_CSV' ? 'shopify-csv-provisional'
    : input.sourceKind === 'UNIWARE_CSV' ? 'unicommerce-csv-provisional' : 'generic-csv-provisional';
  return { profileId: adapter, profileVersion: '0.1.0', catalogRows, catalogRowNumbers, stockObservations, rowErrors, rawRows };
}
