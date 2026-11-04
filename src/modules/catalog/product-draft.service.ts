import {
  ConflictException, ForbiddenException, Inject, Injectable,
  NotFoundException, ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import { CategoryAttributeRule, CategorySchemaSnapshot, compileCategorySchema } from './category-attribute-validator';
import { CreateProductDraftDto, UpdateProductDraftDto } from './product-draft.dto';
import { ProductDraftPostgresRepository } from './product-draft.repository';

export interface ProductMutationContext {
  readonly userId: string;
  readonly brandId: string;
  readonly permission: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly sourceKind?: 'MANUAL' | 'IMPORT';
  readonly sourceReference?: string | null;
}

export interface NormalizedProductCreate {
  readonly styleCode: string;
  readonly categoryCode: string;
  readonly categorySchemaVersion: number;
  readonly title: string;
  readonly description: string;
  readonly attributes: Record<string, unknown>;
  readonly variants: Array<Record<string, unknown>>;
}

export const PRODUCT_DRAFT_REPOSITORY = Symbol('PRODUCT_DRAFT_REPOSITORY');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = new Set(['styleCode', 'categoryCode', 'categorySchemaVersion', 'title', 'description', 'attributes', 'variants']);
const PATCH_KEYS = new Set(['title', 'description', 'categorySchemaVersion', 'attributes']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function normalizedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const result = value.normalize('NFC').trim();
  const hasControlCharacter = [...result].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  return result.length > 0 && result.length <= max && !hasControlCharacter ? result : null;
}
function normalizedFreeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const result = value.normalize('NFC').trim();
  return result.length <= max && ![...result].some((character) => character.codePointAt(0) === 0) ? result : null;
}

export function normalizeProductCreate(value: unknown): NormalizedProductCreate {
  if (!isRecord(value) || Object.keys(value).some((key) => !KEYS.has(key))) throw productError('PRODUCT_DRAFT_INVALID');
  const styleCode = normalizedText(value.styleCode, 128);
  const categoryCode = normalizedText(value.categoryCode, 128);
  const title = normalizedText(value.title, 200);
  const description = value.description === undefined ? '' : normalizedFreeText(value.description, 10_000);
  if (!styleCode || !categoryCode
    || !title || description === null
    || !Number.isSafeInteger(value.categorySchemaVersion) || Number(value.categorySchemaVersion) < 1
    || (value.attributes !== undefined && !isRecord(value.attributes))
    || (value.variants !== undefined && (!Array.isArray(value.variants) || value.variants.length > 100))) {
    throw productError('PRODUCT_DRAFT_INVALID');
  }
  const variants = (value.variants ?? []) as unknown[];
  if (!variants.every(isRecord)) throw productError('PRODUCT_DRAFT_INVALID');
  return { styleCode, categoryCode, categorySchemaVersion: Number(value.categorySchemaVersion), title, description,
    attributes: (value.attributes ?? {}) as Record<string, unknown>, variants: variants as Array<Record<string, unknown>> };
}

export function normalizeProductPatch(value: unknown): UpdateProductDraftDto {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).some((key) => !PATCH_KEYS.has(key))) throw productError('PRODUCT_DRAFT_INVALID');
  const result: UpdateProductDraftDto = {};
  if (value.title !== undefined) {
    const title = normalizedText(value.title, 200); if (!title) throw productError('PRODUCT_DRAFT_INVALID'); result.title = title;
  }
  if (value.description !== undefined) {
    const description = normalizedFreeText(value.description, 10_000);
    if (description === null) throw productError('PRODUCT_DRAFT_INVALID');
    result.description = description;
  }
  if (value.categorySchemaVersion !== undefined) {
    if (!Number.isSafeInteger(value.categorySchemaVersion) || Number(value.categorySchemaVersion) < 1) throw productError('PRODUCT_DRAFT_INVALID');
    result.categorySchemaVersion = Number(value.categorySchemaVersion);
  }
  if (value.attributes !== undefined) {
    if (!isRecord(value.attributes)) throw productError('PRODUCT_DRAFT_INVALID');
    result.attributes = value.attributes;
  }
  return result;
}

export function parseProductIfMatch(value: string | string[] | undefined): number {
  const candidate = typeof value === 'string' ? value : undefined;
  if (!candidate || !/^"[1-9]\d{0,15}"$/.test(candidate)) throw productError('PRODUCT_IF_MATCH_INVALID');
  const parsed = Number(candidate.slice(1, -1));
  if (!Number.isSafeInteger(parsed)) throw productError('PRODUCT_IF_MATCH_INVALID');
  return parsed;
}

function productError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

@Injectable()
export class ProductDraftService {
  constructor(@Inject(PRODUCT_DRAFT_REPOSITORY) private readonly repository: ProductDraftPostgresRepository) {}

  async create(input: CreateProductDraftDto | unknown, context: ProductMutationContext): Promise<Record<string, unknown>> {
    try { return await this.repository.create(normalizeProductCreate(input), context); }
    catch (error) { throw mapProductError(error); }
  }

  async update(productId: string, input: UpdateProductDraftDto | unknown, ifMatch: string | string[] | undefined,
    context: ProductMutationContext): Promise<Record<string, unknown>> {
    if (!UUID.test(productId)) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'The requested product was not found.' });
    try { return await this.repository.update(productId, normalizeProductPatch(input), parseProductIfMatch(ifMatch), context); }
    catch (error) { throw mapProductError(error); }
  }
}

function mapProductError(error: unknown): unknown {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'PRODUCT_DRAFT_INVALID' || code === 'PRODUCT_IF_MATCH_INVALID') return new UnprocessableEntityException({ code, message: 'The product draft request is invalid.' });
  if (code === 'PRODUCT_CONFLICT' || code === 'PRODUCT_IDEMPOTENCY_CONFLICT' || code === 'PRODUCT_ROW_VERSION_CONFLICT') return new ConflictException({ code, message: 'The product draft changed or conflicts with an earlier request.' });
  if (code === 'PRODUCT_NOT_FOUND') return new NotFoundException({ code, message: 'The requested product was not found.' });
  if (code === 'PRODUCT_ACCESS_DENIED') return new ForbiddenException({ code, message: 'The operation could not be authorized.' });
  if (code === 'PRODUCT_CATEGORY_INVALID' || code === 'PRODUCT_ATTRIBUTE_INVALID' || code === 'PRODUCT_STATE_RESTRICTED') return new UnprocessableEntityException({ code, message: 'The product draft does not match an active category or brand state.' });
  if (code === 'PRODUCT_DATABASE_UNAVAILABLE') return new ServiceUnavailableException({ code, message: 'Product draft storage is temporarily unavailable.' });
  return error;
}

export function validateProductAttributes(categoryId: string, versionId: string, version: number,
  validatorVersion: string, rules: CategoryAttributeRule[], values: Record<string, unknown>): Record<string, unknown> {
  const snapshot: CategorySchemaSnapshot = { categoryId, categorySchemaVersionId: versionId, categorySchemaVersion: version, validatorVersion, rules };
  const schema = compileCategorySchema(snapshot);
  const result = schema.validate({ product: values }, { mode: 'draft' });
  if (!result.valid) throw productError('PRODUCT_ATTRIBUTE_INVALID');
  return { ...result.normalizedValues.product };
}
