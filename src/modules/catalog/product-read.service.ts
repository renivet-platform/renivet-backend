import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { BrandAccessContext } from '../access/brand-access.guard';
import { ProductReadRepository } from './product-read.repository';

export interface ProductListQuery { readonly cursor?: string; readonly limit?: string | number; readonly categoryId?: string; readonly reviewState?: string; readonly visibility?: string; }
export interface ProductListPage { readonly cursor: string | null; readonly limit: number; readonly categoryId: string | null; readonly reviewState: string | null; readonly visibility: string | null; }
export const PRODUCT_READ_REPOSITORY = Symbol('PRODUCT_READ_REPOSITORY');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEW_STATES = new Set(['NOT_SUBMITTED', 'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUPERSEDED']);
const VISIBILITIES = new Set(['PUBLIC', 'PRIVATE', 'RESTRICTED']);

export function parseProductListQuery(query: ProductListQuery): ProductListPage {
  const allowed = new Set(['cursor', 'limit', 'categoryId', 'reviewState', 'visibility']);
  if (Object.keys(query).some((key) => !allowed.has(key))) throw new BadRequestException({ code: 'PRODUCT_QUERY_INVALID', message: 'The product list query is invalid.' });
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 512)) throw invalid();
  const limit = query.limit === undefined ? 25 : typeof query.limit === 'number' ? query.limit
    : typeof query.limit === 'string' && /^\d{1,3}$/.test(query.limit) ? Number(query.limit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid();
  const categoryId = query.categoryId;
  const reviewState = query.reviewState;
  const visibility = query.visibility;
  if (categoryId !== undefined && (typeof categoryId !== 'string' || !UUID.test(categoryId))) throw invalid();
  if (reviewState !== undefined && (typeof reviewState !== 'string' || !REVIEW_STATES.has(reviewState))) throw invalid();
  if (visibility !== undefined && (typeof visibility !== 'string' || !VISIBILITIES.has(visibility))) throw invalid();
  return { cursor: query.cursor ?? null, limit, categoryId: categoryId ?? null, reviewState: reviewState ?? null, visibility: visibility ?? null };
}

@Injectable()
export class ProductReadService {
  constructor(@Inject(PRODUCT_READ_REPOSITORY) private readonly repository: ProductReadRepository) {}
  async list(context: BrandAccessContext, query: ProductListQuery) {
    const page = parseProductListQuery(query);
    try { return await this.repository.list(context, page); } catch (error) { throw mapError(error); }
  }
  async get(context: BrandAccessContext, productId: string) {
    if (!UUID.test(productId)) throw invalid();
    try { return await this.repository.get(context, productId); } catch (error) { throw mapError(error); }
  }
}

function invalid() { return new BadRequestException({ code: 'PRODUCT_QUERY_INVALID', message: 'The product identifier or list query is invalid.' }); }
function mapError(error: unknown): unknown {
  switch ((error as { code?: string } | null)?.code) {
    case 'PRODUCT_READ_FORBIDDEN': return new ForbiddenException({ code: 'BRAND_ACCESS_DENIED', message: 'The operation could not be authorized.' });
    case 'PRODUCT_NOT_FOUND': return new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'The requested product was not found.' });
    case 'PRODUCT_CURSOR_INVALID': return invalid();
    case 'PRODUCT_READ_UNAVAILABLE': return new ServiceUnavailableException({ code: 'PRODUCT_READ_UNAVAILABLE', message: 'Product data is temporarily unavailable.' });
    default: return error;
  }
}
