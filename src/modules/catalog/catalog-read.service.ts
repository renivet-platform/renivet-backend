import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BrandAccessContext } from '../access/brand-access.guard';
import { CatalogReadRepository } from './catalog-read.repository';

export interface TaxonomyPageQuery { readonly cursor?: string; readonly limit?: string | number; }

export function parseTaxonomyPage(query: TaxonomyPageQuery): { cursor: string | null; limit: number } {
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 512)) {
    throw new BadRequestException({ code: 'TAXONOMY_CURSOR_INVALID', message: 'The category read cursor is invalid.' });
  }
  const limit = query.limit === undefined ? 25
    : typeof query.limit === 'number' ? query.limit
      : typeof query.limit === 'string' && /^\d{1,3}$/.test(query.limit) ? Number(query.limit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new BadRequestException({ code: 'TAXONOMY_LIMIT_INVALID', message: 'The category read limit is invalid.' });
  }
  return { cursor: query.cursor ?? null, limit };
}

export const CATALOG_READ_REPOSITORY = Symbol('CATALOG_READ_REPOSITORY');

@Injectable()
export class CatalogReadService {
  constructor(@Inject(CATALOG_READ_REPOSITORY) private readonly repository: CatalogReadRepository) {}

  async listCategories(context: BrandAccessContext, query: TaxonomyPageQuery) {
    const page = parseTaxonomyPage(query);
    try { return await this.repository.listCategories(context, page.cursor, page.limit); }
    catch (error) { throw mapReadError(error); }
  }

  async getCategoryAttributes(context: BrandAccessContext, categoryId: string, query: TaxonomyPageQuery) {
    if (!isUuid(categoryId)) throw new BadRequestException({ code: 'CATEGORY_ID_INVALID', message: 'The category identifier is invalid.' });
    const page = parseTaxonomyPage(query);
    try { return await this.repository.getCategoryAttributes(context, categoryId, page.cursor, page.limit); }
    catch (error) { throw mapReadError(error); }
  }

  async getCategorySchemaVersion(context: BrandAccessContext, categoryId: string, rawVersion: string) {
    if (!isUuid(categoryId) || !/^\d{1,10}$/.test(rawVersion)) {
      throw new BadRequestException({ code: 'CATEGORY_VERSION_INVALID', message: 'The category schema version is invalid.' });
    }
    const version = Number(rawVersion);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new BadRequestException({ code: 'CATEGORY_VERSION_INVALID', message: 'The category schema version is invalid.' });
    }
    try { return await this.repository.getCategorySchemaVersion(context, categoryId, version); }
    catch (error) { throw mapReadError(error); }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function mapReadError(error: unknown): unknown {
  switch ((error as { code?: string } | null)?.code) {
    case 'CATALOG_READ_FORBIDDEN':
      return new ForbiddenException({ code: 'BRAND_ACCESS_DENIED', message: 'The operation could not be authorized.' });
    case 'CATEGORY_NOT_FOUND':
    case 'CATEGORY_SCHEMA_VERSION_NOT_FOUND':
      return new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'The requested category or published schema version was not found.' });
    case 'CATEGORY_CURSOR_INVALID':
      return new BadRequestException({ code: 'TAXONOMY_CURSOR_INVALID', message: 'The category read cursor is invalid.' });
    case 'CATEGORY_CURSOR_VERSION_CHANGED':
      return new BadRequestException({ code: 'TAXONOMY_CURSOR_STALE', message: 'The current category schema changed; restart pagination.' });
    case 'CATALOG_READ_UNAVAILABLE':
      return new ServiceUnavailableException({ code: 'CATALOG_READ_UNAVAILABLE', message: 'Category data is temporarily unavailable.' });
    default:
      return error;
  }
}
