import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MediaMutationContext } from './media.service';
import { AttachProductMediaDto, UpdateProductMediaDto } from './product-media.dto';

export type ProductMediaMutationContext = MediaMutationContext;

export interface ProductMediaRepositoryPort {
  attach(productId: string, input: AttachProductMediaDto, context: ProductMediaMutationContext): Promise<Record<string, unknown>>;
  update(productId: string, linkId: string, input: UpdateProductMediaDto, rowVersion: number,
    context: ProductMediaMutationContext): Promise<Record<string, unknown>>;
  detach(productId: string, linkId: string, rowVersion: number,
    context: ProductMediaMutationContext): Promise<Record<string, unknown>>;
}

export class ProductMediaError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code); this.name = 'ProductMediaError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeAttachMedia(value: unknown): AttachProductMediaDto {
  if (!isRecord(value) || Object.keys(value).some((key) => !['mediaAssetId','variantId','displayRole','displayOrder','altText'].includes(key))
    || typeof value.mediaAssetId !== 'string' || !UUID.test(value.mediaAssetId)
    || (value.variantId !== undefined && value.variantId !== null && (typeof value.variantId !== 'string' || !UUID.test(value.variantId)))
    || typeof value.displayRole !== 'string' || !value.displayRole.trim() || value.displayRole.trim().length > 64
    || !Number.isSafeInteger(value.displayOrder) || Number(value.displayOrder) < 0 || Number(value.displayOrder) > 2147483647
    || (value.altText !== undefined && (typeof value.altText !== 'string' || value.altText.length > 500))) {
    throw new ProductMediaError(422, 'PRODUCT_MEDIA_INVALID');
  }
  return { mediaAssetId: value.mediaAssetId.toLowerCase(), variantId: value.variantId == null ? null : String(value.variantId).toLowerCase(),
    displayRole: value.displayRole.trim(), displayOrder: Number(value.displayOrder), altText: (value.altText as string | undefined)?.trim() ?? '' };
}

export function normalizeUpdateMedia(value: unknown): UpdateProductMediaDto {
  if (!isRecord(value) || Object.keys(value).length === 0
    || Object.keys(value).some((key) => !['displayOrder','displayRole','altText'].includes(key))
    || (value.displayOrder !== undefined && (!Number.isSafeInteger(value.displayOrder) || Number(value.displayOrder) < 0 || Number(value.displayOrder) > 2147483647))
    || (value.displayRole !== undefined && (typeof value.displayRole !== 'string' || !value.displayRole.trim() || value.displayRole.trim().length > 64))
    || (value.altText !== undefined && (typeof value.altText !== 'string' || value.altText.length > 500))) {
    throw new ProductMediaError(422, 'PRODUCT_MEDIA_INVALID');
  }
  return { ...(value.displayOrder === undefined ? {} : { displayOrder: Number(value.displayOrder) }),
    ...(value.displayRole === undefined ? {} : { displayRole: (value.displayRole as string).trim() }),
    ...(value.altText === undefined ? {} : { altText: (value.altText as string).trim() }) };
}

export function parseProductMediaIfMatch(value: string | string[] | undefined): number {
  if (typeof value !== 'string' || !/^"[1-9][0-9]*"$/.test(value)) throw new ProductMediaError(422, 'PRODUCT_MEDIA_IF_MATCH_INVALID');
  const version = Number(value.slice(1, -1));
  if (!Number.isSafeInteger(version) || version < 1 || version >= 9007199254740991) {
    throw new ProductMediaError(422, 'PRODUCT_MEDIA_IF_MATCH_INVALID');
  }
  return version;
}

@Injectable()
export class ProductMediaService {
  constructor(private readonly repository: ProductMediaRepositoryPort) {}

  attach(productId: string, value: unknown, context: ProductMediaMutationContext): Promise<Record<string, unknown>> {
    return this.repository.attach(productId, normalizeAttachMedia(value), context);
  }
  update(productId: string, linkId: string, value: unknown, ifMatch: string | string[] | undefined,
    context: ProductMediaMutationContext): Promise<Record<string, unknown>> {
    return this.repository.update(productId, linkId, normalizeUpdateMedia(value), parseProductMediaIfMatch(ifMatch), context);
  }
  detach(productId: string, linkId: string, ifMatch: string | string[] | undefined,
    context: ProductMediaMutationContext): Promise<Record<string, unknown>> {
    return this.repository.detach(productId, linkId, parseProductMediaIfMatch(ifMatch), context);
  }
}

export function productMediaRequestHash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
