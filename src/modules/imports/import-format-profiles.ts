export type WorkbookCell = string | number | boolean | null | undefined;
export interface WorkbookSheet { name: string; rows: WorkbookCell[][]; rowNumbers?: number[] }
export interface ImportFormatProfile {
  readonly id: string;
  readonly version: string;
  readonly provisional: boolean;
  readonly sourceKind: 'RENIVET_XLSX';
  readonly detect: (sheets: WorkbookSheet[]) => boolean;
  readonly map: (sheets: WorkbookSheet[]) => MappedWorkbook;
}
export interface CatalogImportRow {
  sourceRecordKey: string;
  sourceProductKey: string | null;
  title: string;
  sku: string;
  options: Record<string, string>;
  attributes: Record<string, string>;
  sourceMrp?: number;
  sourceImageUrl?: string;
  variants?: Array<{ sku: string; options: Record<string, string> }>;
  sourceVariantDetails?: Array<{ sku: string; barcode?: string; price?: number; compareAtPrice?: number; rawPrice?: string; rawCompareAtPrice?: string }>;
  sourceImageUrls?: Array<{ url: string; sourceRowNumber: number; sourceColumn: string; variantSku?: string }>;
  sourceRowNumbers?: number[];
  sourceLossyFields?: string[];
  reviewCodes?: string[];
}
export interface StockObservation { sourceRecordKey: string; locationKey?: string; quantity: number }
export interface MappedWorkbook {
  profileId: string;
  profileVersion: string;
  catalogRows: CatalogImportRow[];
  catalogRowNumbers: number[];
  stockObservations: StockObservation[];
  rowErrors: Array<{ sourceRowNumber: number; code: string }>;
  rawRows: Array<{ sourceRowNumber: number; rawRecord: Record<string, string> }>;
}

function normalized(value: WorkbookCell): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}
function sheet(sheets: WorkbookSheet[], name: string): WorkbookSheet | undefined {
  return sheets.find((item) => item.name.toLowerCase() === name.toLowerCase());
}
function tableRows(input: WorkbookSheet | undefined): { headers: string[]; rows: WorkbookCell[][]; rowNumbers: number[] } {
  if (!input) return { headers: [], rows: [], rowNumbers: [] };
  // Vendor templates often have a preamble; select the first row with meaningful column labels.
  const headerIndex = input.rows.findIndex((row) => {
    const labels = row.map((cell) => normalized(cell)).filter(Boolean);
    return labels.length >= 3 && labels.every((label) => typeof label === 'string' && Number.isNaN(Number(label)));
  });
  if (headerIndex < 0) return { headers: [], rows: [], rowNumbers: [] };
  const rowNumbers = input.rowNumbers ?? input.rows.map((_, index) => index + 1);
  return { headers: input.rows[headerIndex].map((cell) => normalized(cell).toLowerCase()),
    rows: input.rows.slice(headerIndex + 1), rowNumbers: rowNumbers.slice(headerIndex + 1) };
}
function column(headers: string[], name: string): number { return headers.indexOf(name.toLowerCase()); }
function value(row: WorkbookCell[], headers: string[], name: string): string { const i = column(headers, name); return i < 0 ? '' : normalized(row[i]); }
function numeric(text: string): number | undefined {
  if (!text || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function nonEmpty(rows: WorkbookCell[][]): WorkbookCell[][] { return rows.filter((row) => row.some((cell) => normalized(cell))); }

function mapShopify(sheets: WorkbookSheet[]): MappedWorkbook {
  const table = tableRows(sheet(sheets, 'MASTER DATA'));
  const catalogRows: CatalogImportRow[] = [];
  const catalogRowNumbers: number[] = [];
  const stockObservations: StockObservation[] = [];
  const rowErrors: Array<{ sourceRowNumber: number; code: string }> = [];
  const rawRows: Array<{ sourceRowNumber: number; rawRecord: Record<string, string> }> = [];
  for (const [index, row] of table.rows.entries()) {
    if (!row.some((cell) => normalized(cell))) continue;
    const sourceRowNumber = table.rowNumbers[index] ?? index + 2;
    rawRows.push({ sourceRowNumber, rawRecord: Object.fromEntries(table.headers.map((header, i) => [header, normalized(row[i])])) });
    const sku = value(row, table.headers, 'UNIQUE PRODUCT CODE') || value(row, table.headers, 'EAN');
    const title = value(row, table.headers, 'STYLE NAME');
    if (!sku || !title) { rowErrors.push({ sourceRowNumber, code: 'IMPORT_ROW_REQUIRED_FIELD' }); continue; }
    const ean = value(row, table.headers, 'EAN');
    const composition = value(row, table.headers, 'COMPOSITION');
    const mrp = numeric(value(row, table.headers, 'MRP'));
    const image = value(row, table.headers, 'Image Link');
    const catalog: CatalogImportRow = {
      sourceRecordKey: sku,
      sourceProductKey: value(row, table.headers, 'Shopify Handle') || null,
      title,
      sku,
      options: Object.fromEntries(['COLOR', 'SIZE'].map((name) => [name.toLowerCase(), value(row, table.headers, name)]).filter(([, v]) => v)),
      attributes: Object.fromEntries([['ean', ean], ['composition', composition]].filter(([, v]) => v)),
    };
    if (mrp !== undefined) catalog.sourceMrp = mrp;
    if (/^https:\/\//i.test(image)) catalog.sourceImageUrl = image;
    catalogRows.push(catalog);
    catalogRowNumbers.push(sourceRowNumber);
    const quantity = numeric(value(row, table.headers, 'Inventory'));
    if (quantity !== undefined && quantity >= 0) stockObservations.push({ sourceRecordKey: sku, quantity });
  }
  return { profileId: 'shopify-universal-xlsx-provisional', profileVersion: '0.1.0', catalogRows, catalogRowNumbers, stockObservations, rowErrors, rawRows };
}

function mapUnicommerce(sheets: WorkbookSheet[]): MappedWorkbook {
  const itemTable = tableRows(sheet(sheets, 'Uniware_API_Items'));
  const stockTable = tableRows(sheet(sheets, 'Inventory_Snapshot'));
  const rowErrors: Array<{ sourceRowNumber: number; code: string }> = [];
  const rawRows: Array<{ sourceRowNumber: number; rawRecord: Record<string, string> }> = [];
  const catalogRows: CatalogImportRow[] = itemTable.rows.flatMap((row, index) => {
    if (!row.some((cell) => normalized(cell))) return [];
    const sourceRowNumber = itemTable.rowNumbers[index] ?? index + 2;
    rawRows.push({ sourceRowNumber, rawRecord: Object.fromEntries(itemTable.headers.map((header, i) => [header, normalized(row[i])])) });
    const sku = value(row, itemTable.headers, 'skuCode');
    const title = value(row, itemTable.headers, 'name');
    if (!sku || !title) { rowErrors.push({ sourceRowNumber, code: 'IMPORT_ROW_REQUIRED_FIELD' }); return []; }
    const options = Object.fromEntries(['color', 'size'].map((name) => [name, value(row, itemTable.headers, name)]).filter(([, v]) => v));
    const catalog: CatalogImportRow = { sourceRecordKey: sku, sourceProductKey: null, title, sku, options, attributes: {} };
    const mrp = numeric(value(row, itemTable.headers, 'maxRetailPrice'));
    if (mrp !== undefined) catalog.sourceMrp = mrp;
    return [catalog];
  });
  const stockObservations: StockObservation[] = nonEmpty(stockTable.rows).flatMap((row) => {
    const sku = value(row, stockTable.headers, 'itemTypeSKU');
    const locationKey = value(row, stockTable.headers, 'facilityCode');
    const quantity = numeric(value(row, stockTable.headers, 'inventory'));
    return sku && locationKey && quantity !== undefined && quantity >= 0 ? [{ sourceRecordKey: sku, locationKey, quantity }] : [];
  });
  const catalogRowNumbers = itemTable.rows.flatMap((row, index) => row.some((cell) => normalized(cell))
    && value(row, itemTable.headers, 'skuCode') && value(row, itemTable.headers, 'name') ? [itemTable.rowNumbers[index] ?? index + 2] : []);
  return { profileId: 'unicommerce-comprehensive-xlsx-illustrative', profileVersion: '0.1.0', catalogRows, catalogRowNumbers, stockObservations, rowErrors, rawRows };
}

const PROFILES: readonly ImportFormatProfile[] = [
  { id: 'shopify-universal-xlsx-provisional', version: '0.1.0', provisional: true, sourceKind: 'RENIVET_XLSX',
    detect: (sheets) => {
      const headers = tableRows(sheet(sheets, 'MASTER DATA')).headers;
      return headers.includes('unique product code') && headers.includes('style name');
    },
    map: mapShopify },
  { id: 'unicommerce-comprehensive-xlsx-illustrative', version: '0.1.0', provisional: true, sourceKind: 'RENIVET_XLSX',
    detect: (sheets) => {
      const itemHeaders = tableRows(sheet(sheets, 'Uniware_API_Items')).headers;
      const stockHeaders = tableRows(sheet(sheets, 'Inventory_Snapshot')).headers;
      return itemHeaders.includes('skucode') && itemHeaders.includes('name')
        && stockHeaders.includes('facilitycode') && stockHeaders.includes('itemtypesku') && stockHeaders.includes('inventory');
    },
    map: mapUnicommerce },
];

export function detectImportFormatProfile(input: { sourceKind: string; sheets: WorkbookSheet[] }): ImportFormatProfile {
  if (input.sourceKind !== 'RENIVET_XLSX') throw Object.assign(new Error('The workbook format is not recognized.'), { code: 'IMPORT_FORMAT_UNRECOGNIZED' });
  const matches = PROFILES.filter((profile) => profile.detect(input.sheets));
  if (matches.length !== 1) throw Object.assign(new Error('The workbook format is not recognized.'), { code: 'IMPORT_FORMAT_UNRECOGNIZED' });
  return matches[0];
}

export function mapImportWorkbook(input: { profile: ImportFormatProfile; sheets: WorkbookSheet[] }): MappedWorkbook {
  if (!input.profile.provisional || !PROFILES.some((profile) => profile.id === input.profile.id && profile.version === input.profile.version)) {
    throw Object.assign(new Error('The selected import format profile is not available.'), { code: 'IMPORT_FORMAT_UNRECOGNIZED' });
  }
  const mapped = input.profile.map(input.sheets);
  if (mapped.rawRows.length > 5_000) {
    throw Object.assign(new Error('The file contains more than 5,000 catalog rows.'), { code: 'IMPORT_ROW_LIMIT_EXCEEDED' });
  }
  return mapped;
}
