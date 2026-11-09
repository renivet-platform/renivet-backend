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

function parseShopifyProductCsv(headers: string[], data: string[][]): MappedWorkbook {
  const indexOf = (names: string[]) => headers.findIndex((header) => names.includes(header));
  const values = (row: string[]) => headers.map((header, index) => [header, (row[index] ?? '').trim()] as const);
  const get = (row: string[], names: string[]) => {
    const index = indexOf(names);
    return index < 0 ? '' : (row[index] ?? '').trim();
  };
  const handleIndex = indexOf(['url handle', 'handle']);
  const titleIndex = indexOf(['title']);
  const skuIndex = indexOf(['sku', 'variant sku']);
  if (handleIndex < 0 || titleIndex < 0 || skuIndex < 0 || indexOf(['option1 value']) < 0) {
    throw new ImportCsvError('IMPORT_CSV_HEADER_INVALID');
  }

  const groups = new Map<string, Array<{ row: string[]; rowNumber: number }>>();
  const rowErrors: Array<{ sourceRowNumber: number; code: string }> = [];
  const rawRows: MappedWorkbook['rawRows'] = [];
  for (const [index, row] of data.entries()) {
    const rowNumber = index + 2;
    const handle = (row[handleIndex] ?? '').trim();
    if (!handle) {
      rowErrors.push({ sourceRowNumber: rowNumber, code: 'SHOPIFY_HANDLE_MISSING' });
      rawRows.push({ sourceRowNumber: rowNumber, rawRecord: Object.fromEntries(values(row)) });
      continue;
    }
    groups.set(handle, [...(groups.get(handle) ?? []), { row, rowNumber }]);
  }

  const catalogRows: CatalogImportRow[] = [];
  const catalogRowNumbers: number[] = [];
  for (const [handle, lines] of groups) {
    const titleLine = lines.find(({ row }) => (row[titleIndex] ?? '').trim());
    const title = titleLine ? (titleLine.row[titleIndex] ?? '').trim() : '';
    const representative = titleLine ?? lines[0];
    const variants: NonNullable<CatalogImportRow['variants']> = [];
    const sourceVariantDetails: NonNullable<CatalogImportRow['sourceVariantDetails']> = [];
    const sourceImageUrls: NonNullable<CatalogImportRow['sourceImageUrls']> = [];
    const sourceRowNumbers = lines.map(({ rowNumber }) => rowNumber);
    let invalidPrice = false;
    const materialColumns = headers.flatMap((header, column) => /(?:material|fabric|composition)/i.test(header) ? [column] : []);
    const materialIndex = materialColumns.find((column) => lines.some(({ row }) => Boolean((row[column] ?? '').trim()))) ?? materialColumns[0];
    const ignoredMaterialColumns = materialColumns.filter((column) => column !== materialIndex
      && lines.some(({ row }) => Boolean((row[column] ?? '').trim())));
    const supportedSourceHeaders = new Set(['url handle', 'handle', 'title', 'sku', 'variant sku', 'variant barcodes', 'barcodes', 'barcode',
      'option1 name', 'option1 value', 'option2 name', 'option2 value', 'option3 name', 'option3 value', 'price', 'compare-at price',
      'compare at price', 'product image url', 'image url', 'image src', 'variant image url', 'product category', 'type']);
    const sourceLossyFields = headers.filter((header, column) => (!supportedSourceHeaders.has(header)
      && !/(?:material|fabric|composition)/i.test(header) || ignoredMaterialColumns.includes(column))
      && lines.some(({ row }) => Boolean((row[column] ?? '').trim())));
    const optionNames = [1, 2, 3].map((n) => lines.map(({ row }) => get(row, [`option${n} name`]).toLowerCase()).find(Boolean) ?? '');
    let material = '';
    for (const { row, rowNumber } of lines) {
      const sku = (row[skuIndex] ?? '').trim();
      if (sku) {
        const options: Record<string, string> = {};
        for (const n of [1, 2, 3]) {
          const name = get(row, [`option${n} name`]) || optionNames[n - 1] || `option${n}`;
          const value = get(row, [`option${n} value`]);
          if (value && !/^(?:\s*|\bdefault title\b)$/i.test(value)) options[name.toLowerCase()] = value;
        }
        variants.push({ sku, options });
        const detail: NonNullable<CatalogImportRow['sourceVariantDetails']>[number] = { sku };
        const barcode = get(row, ['variant barcodes', 'barcodes', 'barcode']);
        const rawPrice = get(row, ['price']);
        const rawCompareAtPrice = get(row, ['compare-at price', 'compare at price']);
        const price = sourceNumber(rawPrice);
        const compareAtPrice = sourceNumber(rawCompareAtPrice);
        if (barcode) detail.barcode = barcode;
        if (price !== undefined) detail.price = price;
        else if (rawPrice) { detail.rawPrice = rawPrice; invalidPrice = true; }
        if (compareAtPrice !== undefined) detail.compareAtPrice = compareAtPrice;
        else if (rawCompareAtPrice) { detail.rawCompareAtPrice = rawCompareAtPrice; invalidPrice = true; }
        sourceVariantDetails.push(detail);
      }
      for (const [imageHeader, variantSpecific] of [['product image url', false], ['image url', false], ['image src', false], ['variant image url', true]] as const) {
        const image = get(row, [imageHeader]);
        if (/^https?:\/\//i.test(image) && !sourceImageUrls.some((item) => item.url === image && item.sourceColumn === imageHeader
          && item.variantSku === (variantSpecific ? (row[skuIndex] ?? '').trim() || undefined : undefined))) {
          sourceImageUrls.push({ url: image, sourceRowNumber: rowNumber, sourceColumn: imageHeader,
            ...(variantSpecific && (row[skuIndex] ?? '').trim() ? { variantSku: (row[skuIndex] ?? '').trim() } : {}) });
        }
      }
      if (!material) {
        if (materialIndex !== undefined) material = (row[materialIndex] ?? '').trim();
      }
    }
    const sourceProductCategory = lines.map(({ row }) => get(row, ['product category'])).find(Boolean)
      ?? lines.map(({ row }) => get(row, ['type'])).find(Boolean) ?? '';
    const reviewCodes: string[] = [];
    if (!sourceProductCategory) reviewCodes.push('SHOPIFY_CATEGORY_MISSING');
    if (!material) reviewCodes.push('SHOPIFY_MATERIAL_MISSING');
    if (!variants.some((variant) => Object.entries(variant.options).some(([name, value]) => /size/i.test(name) && value))) {
      reviewCodes.push('SHOPIFY_SIZE_MISSING');
    }
    if (sourceLossyFields.length) reviewCodes.push('SHOPIFY_UNMAPPED_FIELDS');
    if (new Set(variants.map(({ sku }) => sku.toLocaleUpperCase('en-US'))).size !== variants.length) {
      reviewCodes.push('SHOPIFY_DUPLICATE_VARIANT_SKU');
    }
    if (invalidPrice) reviewCodes.push('SHOPIFY_PRICE_INVALID');
    if (!title || variants.length === 0 || variants.length > 100) {
      rowErrors.push({ sourceRowNumber: representative.rowNumber, code: !title || variants.length === 0
        ? 'IMPORT_ROW_REQUIRED_FIELD' : 'IMPORT_VARIANT_LIMIT_EXCEEDED' });
    }
    rawRows.push({ sourceRowNumber: representative.rowNumber,
      rawRecord: Object.fromEntries(values(representative.row)) });
    if (!title || variants.length === 0 || variants.length > 100) continue;
    const product: CatalogImportRow = { sourceRecordKey: handle, sourceProductKey: handle, title, sku: variants[0].sku,
      options: variants[0].options, attributes: material ? { material } : {}, variants, sourceVariantDetails,
      sourceImageUrls, sourceRowNumbers, sourceLossyFields, reviewCodes };
    catalogRows.push(product);
    catalogRowNumbers.push(representative.rowNumber);
  }
  rawRows.sort((left, right) => left.sourceRowNumber - right.sourceRowNumber);
  if (catalogRows.length > MAX_IMPORT_ROWS) throw new ImportCsvError('IMPORT_ROW_LIMIT_EXCEEDED');
  return { profileId: 'shopify-product-csv', profileVersion: '2026-11-09', catalogRows, catalogRowNumbers,
    stockObservations: [], rowErrors, rawRows };
}

export function parseCatalogCsv(input: { bytes: Buffer; sourceKind: string }): MappedWorkbook {
  const [headersRow, ...data] = records(input.bytes);
  const headers = headersRow.map((value) => value.trim().toLowerCase());
  if (headers.some((value) => !value) || new Set(headers).size !== headers.length) throw new ImportCsvError('IMPORT_CSV_HEADER_INVALID');
  if (input.sourceKind === 'SHOPIFY_CSV') return parseShopifyProductCsv(headers, data);
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
