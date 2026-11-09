import { createHash } from 'node:crypto';
import { CategoryAttributeRule, compileCategorySchema } from '../catalog/category-attribute-validator';

export type ImportPreviewAction = 'CREATE' | 'UPDATE' | 'NOOP' | 'CONFLICT' | 'NEEDS_REVIEW' | 'INVALID';

export interface ImportPreviewSourceRow {
  rowNumber: number;
  rawRecord: Record<string, unknown>;
  canonicalRecord?: Record<string, unknown> | null;
  validationErrors?: Array<{ code: string }>;
}

export interface ImportPreviewMapping {
  version: number;
  fields: Record<string, string>;
  categories: Record<string, string>;
}

export interface ImportPreviewTarget {
  rowNumber?: number;
  productId: string;
  variantId?: string | null;
  productRowVersion?: number;
  variantRowVersion?: number;
  rowVersion: number;
  contentVersion?: number;
  sku?: string | null;
  styleCode?: string | null;
  title?: string | null;
  categoryCode?: string | null;
  productState?: string | null;
  variantState?: string | null;
  attributes?: Record<string, unknown>;
  options?: Record<string, unknown>;
  updatedAt?: string | null;
}

export interface ImportPreviewTaxonomyCategory {
  code: string;
  active: boolean;
  categoryId?: string;
  schemaVersionId?: string;
  schemaVersion?: number;
  validatorVersion?: string;
  attributes?: CategoryAttributeRule[];
}

type ImportPreviewCategoryWithSchema = ImportPreviewTaxonomyCategory & Required<Pick<ImportPreviewTaxonomyCategory,
  'categoryId' | 'schemaVersionId' | 'schemaVersion' | 'validatorVersion' | 'attributes'>>;

function hasPinnedCategorySchema(category: ImportPreviewTaxonomyCategory): category is ImportPreviewCategoryWithSchema {
  return typeof category.categoryId === 'string' && typeof category.schemaVersionId === 'string'
    && Number.isSafeInteger(category.schemaVersion) && (category.schemaVersion ?? 0) > 0
    && typeof category.validatorVersion === 'string' && Array.isArray(category.attributes);
}

export interface ImportPreviewConflict {
  code: string;
  message: string;
}

export interface ImportPreviewRow {
  sourceRowNumber: number;
  action: ImportPreviewAction;
  proposed: Record<string, unknown>;
  fieldMask: string[];
  targetVersion: { productId: string; variantId: string | null; productRowVersion: number; variantRowVersion: number; contentVersion: number } | null;
  conflicts: ImportPreviewConflict[];
}

export interface ImportPreviewSnapshot {
  batchId: string;
  brandId: string;
  previewRevision: number;
  sourceSha256: string;
  sourceAsOf: string;
  mappingVersion: number;
  taxonomyVersion: number;
  taxonomySnapshotSha256: string;
  fieldMasks: string[];
  targetVersions: Array<{ sourceRowNumber: number; productId: string; variantId: string | null; productRowVersion: number; variantRowVersion: number; contentVersion: number }>;
  rows: ImportPreviewRow[];
  counts: Record<'create' | 'update' | 'noop' | 'conflict' | 'review' | 'invalid', number>;
  previewHash: string;
}

const SIMPLE_TARGETS = new Set(['title', 'styleCode', 'sku', 'categoryCode', 'sourceProductKey', 'sourceVariantKey', 'sourceMrp', 'imageUrl']);
const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function fail(code: string): never {
  const error = new Error(code);
  error.name = 'ImportPreviewError';
  Object.assign(error, { code });
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).normalize('NFC').trim() : '';
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function allowedTarget(target: string): boolean {
  if (SIMPLE_TARGETS.has(target)) return true;
  const [scope, code, ...rest] = target.split('.');
  return rest.length === 0 && (scope === 'attributes' || scope === 'options') && CODE_PATTERN.test(code ?? '');
}

function flattenTargets(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, item]) => {
    if (key === 'categoryUnmapped' || key === 'variants' || key === 'mediaAssets') return [];
    const path = prefix ? `${prefix}.${key}` : key;
    return isRecord(item) ? flattenTargets(item, path) : [path];
  });
}

function mappedRecord(row: ImportPreviewSourceRow, mapping: ImportPreviewMapping): Record<string, unknown> {
  const source = new Map(Object.entries(row.rawRecord).map(([key, value]) => [key.trim().toLocaleLowerCase('en-US'), value]));
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [sourceName, target] of Object.entries(mapping.fields)) {
    const raw = source.get(sourceName.trim().toLocaleLowerCase('en-US'));
    if (raw === undefined || raw === null || raw === '') continue;
    if (!allowedTarget(target)) fail('IMPORT_MAPPING_INVALID');
    if (SIMPLE_TARGETS.has(target)) {
      result[target] = target === 'sourceMrp' && typeof raw === 'string' && /^\d+(?:\.\d{1,2})?$/.test(raw.trim()) ? Number(raw) : normalizeText(raw);
      continue;
    }
    const [scope, code] = target.split('.') as ['attributes' | 'options', string];
    const group = isRecord(result[scope]) ? result[scope] as Record<string, unknown> : Object.create(null) as Record<string, unknown>;
    group[code] = normalizeText(raw);
    result[scope] = group;
  }
  if (typeof result.categoryCode === 'string') {
    const categoryMap = new Map(Object.entries(mapping.categories).map(([sourceCode, targetCode]) => [sourceCode.trim().toLocaleLowerCase('en-US'), targetCode]));
    const mapped = categoryMap.get(result.categoryCode.trim().toLocaleLowerCase('en-US'));
    result.categoryCode = mapped ?? result.categoryCode;
    if (!mapped) result.categoryUnmapped = true;
  }
  const canonicalRecord = isRecord(row.canonicalRecord) ? row.canonicalRecord : {};
  if (Array.isArray(canonicalRecord.variants)) {
    if (canonicalRecord.variants.length < 1 || canonicalRecord.variants.length > 100 || !canonicalRecord.variants.every((item) => isRecord(item)
      && typeof item.sku === 'string' && isRecord(item.options))) fail('IMPORT_VARIANTS_INVALID');
    result.variants = canonicalRecord.variants;
  }
  if (Array.isArray(canonicalRecord.mediaAssets)) {
    if (canonicalRecord.mediaAssets.length > 50 || !canonicalRecord.mediaAssets.every((item) => isRecord(item)
      && typeof item.mediaAssetId === 'string' && /^[0-9a-f-]{36}$/i.test(item.mediaAssetId))) fail('IMPORT_MEDIA_ASSETS_INVALID');
    result.mediaAssets = canonicalRecord.mediaAssets;
  }
  return result;
}

function actionCounts(rows: ImportPreviewRow[]): ImportPreviewSnapshot['counts'] {
  const counts: ImportPreviewSnapshot['counts'] = { create: 0, update: 0, noop: 0, conflict: 0, review: 0, invalid: 0 };
  for (const row of rows) {
    if (row.action === 'CREATE') counts.create += 1;
    else if (row.action === 'UPDATE') counts.update += 1;
    else if (row.action === 'NOOP') counts.noop += 1;
    else if (row.action === 'CONFLICT') counts.conflict += 1;
    else if (row.action === 'NEEDS_REVIEW') counts.review += 1;
    else counts.invalid += 1;
  }
  return counts;
}

export function buildImportPreview(input: {
  previewRevision?: number;
  batch: { id: string; brandId: string; sourceSha256: string; sourceAsOf: string; mode?: string };
  mapping: ImportPreviewMapping;
  taxonomy: { version: number; snapshotSha256: string; categories: ImportPreviewTaxonomyCategory[] };
  sourceRows: ImportPreviewSourceRow[];
  targets: ImportPreviewTarget[];
  fieldMasks?: string[];
}): ImportPreviewSnapshot {
  if (!isRecord(input) || !isRecord(input.batch) || !isRecord(input.mapping) || !isRecord(input.taxonomy)
    || !Array.isArray(input.sourceRows) || !Array.isArray(input.targets)
    || !Number.isSafeInteger(input.mapping.version) || input.mapping.version < 1
    || !Number.isSafeInteger(input.taxonomy.version) || input.taxonomy.version < 1
    || !/^[a-f0-9]{64}$/i.test(input.batch.sourceSha256) || !/^[a-f0-9]{64}$/i.test(input.taxonomy.snapshotSha256)
    || !isRecord(input.mapping.fields) || !isRecord(input.mapping.categories)) fail('IMPORT_PREVIEW_INVALID');
  const previewRevision = input.previewRevision ?? 1;
  if (!Number.isSafeInteger(previewRevision) || previewRevision < 1) fail('IMPORT_PREVIEW_INVALID');

  const mappedRows = input.sourceRows.map((source) => {
    if (!Number.isSafeInteger(source.rowNumber) || source.rowNumber < 1 || !isRecord(source.rawRecord)) fail('IMPORT_PREVIEW_INVALID');
    return { source, proposed: mappedRecord(source, input.mapping) };
  });
  const requestedMasks = input.fieldMasks ?? [...new Set(mappedRows.flatMap(({ proposed }) => flattenTargets(proposed)))].sort();
  const fieldMasks = [...new Set(requestedMasks)].sort();
  const mappedTargets = Object.values(input.mapping.fields);
  if (fieldMasks.some((field) => !allowedTarget(field)
    || !mappedTargets.includes(field) && !mappedTargets.some((target) => target.startsWith(`${field}.`)))) fail('IMPORT_MAPPING_INVALID');

  const skuRows = new Map<string, number[]>();
  for (const { source, proposed } of mappedRows) {
    const sku = normalizeText(proposed.sku).toLocaleUpperCase('en-US');
    if (sku) skuRows.set(sku, [...(skuRows.get(sku) ?? []), source.rowNumber]);
  }
  const categories = new Map(input.taxonomy.categories.map((category) => [category.code.toLocaleLowerCase('en-US'), category]));
  const schemaValidators = new Map<string, ReturnType<typeof compileCategorySchema>>();
  const rows: ImportPreviewRow[] = mappedRows.map(({ source, proposed }) => {
    const conflicts: ImportPreviewConflict[] = [];
    const rowFieldMasks = fieldMasks.filter((mask) => {
      let current: unknown = proposed;
      for (const part of mask.split('.')) {
        if (!isRecord(current) || !Object.hasOwn(current, part)) return false;
        current = current[part];
      }
      return current !== undefined;
    });
    let invalidAttributeValue = false;
    if (source.validationErrors?.length) {
      return { sourceRowNumber: source.rowNumber, action: 'INVALID', proposed, fieldMask: rowFieldMasks, targetVersion: null,
        conflicts: source.validationErrors.map(({ code }) => ({ code, message: 'The source row contains invalid fields.' })) };
    }
    if (!normalizeText(proposed.title) || !normalizeText(proposed.styleCode) || !normalizeText(proposed.sku)) {
      return { sourceRowNumber: source.rowNumber, action: 'INVALID', proposed, fieldMask: rowFieldMasks, targetVersion: null,
        conflicts: [{ code: 'IMPORT_REQUIRED_FIELD', message: 'Map a title, style code, and SKU before previewing this row.' }] };
    }
    if (proposed.categoryUnmapped) conflicts.push({ code: 'CATEGORY_UNMAPPED', message: 'Map this source category to an active Renivet category.' });
    const sku = normalizeText(proposed.sku).toLocaleUpperCase('en-US');
    if (sku && (skuRows.get(sku)?.length ?? 0) > 1) conflicts.push({ code: 'DUPLICATE_SOURCE_SKU', message: 'The source contains this SKU more than once.' });
    const targets = input.targets.filter((target) => target.rowNumber === source.rowNumber
      || (sku && normalizeText(target.sku).toLocaleUpperCase('en-US') === sku));
    if (targets.length > 1) conflicts.push({ code: 'SKU_TARGET_CONFLICT', message: 'This SKU matches more than one brand-owned target.' });
    const target = targets[0];
    const categoryCode = (normalizeText(proposed.categoryCode) || normalizeText(target?.categoryCode)).toLocaleLowerCase('en-US');
    const category = categoryCode ? categories.get(categoryCode) : undefined;
    if (category?.schemaVersion) proposed.categorySchemaVersion = category.schemaVersion;
    if (!categoryCode && !target) conflicts.push({ code: 'CATEGORY_REQUIRED', message: 'Choose an active category before creating this product.' });
    if (categoryCode && !category && !proposed.categoryUnmapped) conflicts.push({ code: 'CATEGORY_UNMAPPED', message: 'The selected category does not exist in the pinned taxonomy.' });
    else if (category && !category.active) conflicts.push({ code: 'CATEGORY_INACTIVE', message: 'The selected category is not active in the pinned taxonomy.' });
    if (target && proposed.categoryCode && target.categoryCode
      && normalizeText(proposed.categoryCode).toLocaleLowerCase('en-US') !== normalizeText(target.categoryCode).toLocaleLowerCase('en-US')) {
      conflicts.push({ code: 'CATEGORY_CHANGE_REQUIRES_REVIEW', message: 'Changing an existing product category requires a separate reviewed correction.' });
    }
    if (proposed.sourceMrp !== undefined) conflicts.push({ code: 'PRICE_REVIEW_REQUIRED', message: 'Source price data is retained for review and is not applied by catalog confirmation.' });
    if (typeof proposed.imageUrl === 'string' && proposed.imageUrl.trim()) {
      conflicts.push({ code: 'MEDIA_REVIEW_REQUIRED', message: 'Image URLs must pass the approved media intake and rights checks before confirmation.' });
    }
    const mappedAttributes = isRecord(proposed.attributes) ? proposed.attributes : {};
    const mappedOptions = isRecord(proposed.options) ? proposed.options : {};
    if (target && Object.entries(mappedOptions).some(([code, value]) => canonical(target.options?.[code]) !== canonical(value))) {
      conflicts.push({ code: 'SKU_ATTR_CONFLICT', message: 'Changing size, color, or another variant option requires a new SKU or an approved correction.' });
    }
    if (category && !hasPinnedCategorySchema(category)) {
      conflicts.push({ code: 'CATEGORY_SCHEMA_UNAVAILABLE', message: 'The pinned category attribute schema is not available for this preview.' });
    } else if (category && (Object.keys(mappedAttributes).length > 0 || Object.keys(mappedOptions).length > 0)) {
        let validator = schemaValidators.get(category.code);
        if (!validator) {
          validator = compileCategorySchema({ categoryId: category.categoryId, categorySchemaVersionId: category.schemaVersionId,
            categorySchemaVersion: category.schemaVersion, validatorVersion: category.validatorVersion, rules: category.attributes });
          schemaValidators.set(category.code, validator);
        }
        const validation = validator.validate({ product: mappedAttributes, variant: mappedOptions }, { mode: 'draft' });
        for (const issue of validation.issues) {
          conflicts.push({ code: issue.code, message: 'A mapped attribute does not match the pinned category schema.' });
          if (issue.code === 'ATTRIBUTE_VALUE_INVALID') invalidAttributeValue = true;
        }
    }
    if (target && target.productState && !['DRAFT', 'INCOMPLETE', 'PENDING_REVIEW', 'APPROVED', 'RE_REVIEW', 'REJECTED'].includes(target.productState)) {
      conflicts.push({ code: 'PRODUCT_STATE_RESTRICTED', message: 'The matched product cannot be changed in its current state.' });
    }
    if (target && target.variantState && target.variantState !== 'DRAFT') {
      conflicts.push({ code: 'VARIANT_STATE_RESTRICTED', message: 'The matched variant cannot be changed in its current state.' });
    }
    if (target && target.updatedAt && new Date(target.updatedAt).getTime() > new Date(input.batch.sourceAsOf).getTime()) {
      conflicts.push({ code: 'SOURCE_STALE', message: 'A newer product edit exists than the source snapshot.' });
    }
    if (target && proposed.styleCode && target.styleCode && normalizeText(proposed.styleCode).toLocaleUpperCase('en-US') !== normalizeText(target.styleCode).toLocaleUpperCase('en-US')) {
      conflicts.push({ code: 'SKU_TARGET_CONFLICT', message: 'The source SKU is already attached to a different product style.' });
    }
    if (conflicts.length) {
      if (invalidAttributeValue) return { sourceRowNumber: source.rowNumber, action: 'INVALID', proposed, fieldMask: rowFieldMasks,
        targetVersion: target ? { productId: target.productId, variantId: target.variantId ?? null,
          productRowVersion: target.productRowVersion ?? target.rowVersion, variantRowVersion: target.variantRowVersion ?? target.rowVersion,
          contentVersion: target.contentVersion ?? 1 } : null, conflicts };
      const needsReview = conflicts.every(({ code }) => ['CATEGORY_UNMAPPED','CATEGORY_INACTIVE','CATEGORY_REQUIRED','CATEGORY_SCHEMA_UNAVAILABLE',
        'ATTRIBUTE_NOT_IN_SCHEMA','ATTRIBUTE_SCOPE_MISMATCH','CATEGORY_CHANGE_REQUIRES_REVIEW','PRICE_REVIEW_REQUIRED','MEDIA_REVIEW_REQUIRED'].includes(code));
      return { sourceRowNumber: source.rowNumber, action: needsReview ? 'NEEDS_REVIEW' : 'CONFLICT', proposed,
        fieldMask: rowFieldMasks, targetVersion: target ? { productId: target.productId, variantId: target.variantId ?? null,
          productRowVersion: target.productRowVersion ?? target.rowVersion, variantRowVersion: target.variantRowVersion ?? target.rowVersion,
          contentVersion: target.contentVersion ?? 1 } : null, conflicts };
    }
    if (!target) return { sourceRowNumber: source.rowNumber, action: input.batch.mode === 'UPDATE_MATCHED' ? 'CONFLICT' : 'CREATE', proposed,
      fieldMask: rowFieldMasks, targetVersion: null, conflicts: input.batch.mode === 'UPDATE_MATCHED'
        ? [{ code: 'TARGET_NOT_FOUND', message: 'No brand-owned target matches this row.' }] : [] };
    if (input.batch.mode === 'CREATE_ONLY') return { sourceRowNumber: source.rowNumber, action: 'CONFLICT', proposed, fieldMask: rowFieldMasks,
      targetVersion: { productId: target.productId, variantId: target.variantId ?? null,
        productRowVersion: target.productRowVersion ?? target.rowVersion, variantRowVersion: target.variantRowVersion ?? target.rowVersion,
        contentVersion: target.contentVersion ?? 1 }, conflicts: [{ code: 'TARGET_EXISTS', message: 'Create-only imports cannot overwrite a matching target.' }] };
    if (input.batch.mode === 'REVIEW_CONFLICT') return { sourceRowNumber: source.rowNumber, action: 'CONFLICT', proposed, fieldMask: rowFieldMasks,
      targetVersion: { productId: target.productId, variantId: target.variantId ?? null,
        productRowVersion: target.productRowVersion ?? target.rowVersion, variantRowVersion: target.variantRowVersion ?? target.rowVersion,
        contentVersion: target.contentVersion ?? 1 }, conflicts: [{ code: 'TARGET_REQUIRES_REVIEW', message: 'Review the existing target before selecting update fields.' }] };
    const projected = Object.fromEntries(rowFieldMasks.map((mask) => [mask, mask.split('.').reduce<unknown>((current, part) => isRecord(current) ? current[part] : undefined, proposed)]));
    const current = Object.fromEntries(rowFieldMasks.map((mask) => {
      if (mask.startsWith('attributes.')) return [mask, target.attributes?.[mask.slice('attributes.'.length)]];
      if (mask.startsWith('options.')) return [mask, target.options?.[mask.slice('options.'.length)]];
      return [mask, target[mask as keyof ImportPreviewTarget]];
    }));
    const action = input.batch.mode === 'SKIP_EXISTING' || canonical(projected) === canonical(current) ? 'NOOP' : 'UPDATE';
    return { sourceRowNumber: source.rowNumber, action, proposed, fieldMask: rowFieldMasks,
      targetVersion: { productId: target.productId, variantId: target.variantId ?? null,
        productRowVersion: target.productRowVersion ?? target.rowVersion, variantRowVersion: target.variantRowVersion ?? target.rowVersion,
        contentVersion: target.contentVersion ?? 1 }, conflicts: [] };
  });
  const targetVersions = rows.flatMap((row) => row.targetVersion ? [{ sourceRowNumber: row.sourceRowNumber, ...row.targetVersion }] : []);
  const counts = actionCounts(rows);
  const payload = {
    batchId: input.batch.id, brandId: input.batch.brandId, previewRevision, sourceSha256: input.batch.sourceSha256.toLowerCase(), sourceAsOf: input.batch.sourceAsOf,
    mappingVersion: input.mapping.version, mapping: input.mapping, taxonomyVersion: input.taxonomy.version,
    taxonomySnapshotSha256: input.taxonomy.snapshotSha256.toLowerCase(), fieldMasks, targetVersions, rows, counts,
  };
  return { batchId: input.batch.id, brandId: input.batch.brandId, previewRevision, sourceSha256: input.batch.sourceSha256.toLowerCase(),
    sourceAsOf: input.batch.sourceAsOf, mappingVersion: input.mapping.version, taxonomyVersion: input.taxonomy.version,
    taxonomySnapshotSha256: input.taxonomy.snapshotSha256.toLowerCase(), fieldMasks, targetVersions, rows, counts, previewHash: sha256(payload) };
}
