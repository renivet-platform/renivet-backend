import { createHash } from 'node:crypto';
import { Controller, Get, Headers, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiExtension,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { CategoryReadErrorDto, CategorySchemaVersionReadDto, PagedAttributeDefinitionsDto, PagedCategoriesDto } from './catalog-read.dto';
import { CatalogReadService, TaxonomyPageQuery } from './catalog-read.service';

interface ReadResponse {
  header(name: string, value: string): this;
  code(status: number): this;
  send(body?: unknown): unknown;
}

@ApiTags('Catalog')
@ApiCookieAuth('renivetSession')
@Controller('brands/:brandId/categories')
@UseGuards(BrandAccessGuard)
@RequireBrandPermission('catalog.read')
export class CatalogReadController {
  constructor(private readonly catalog: CatalogReadService) {}

  @Get()
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiQuery({ name: 'cursor', required: false, type: 'string' })
  @ApiQuery({ name: 'limit', required: false, type: 'integer', minimum: 1, maximum: 100, default: 25 })
  @ApiOperation({ operationId: 'listCategories', summary: 'List the shared category tree for a brand catalog form', description: 'Returns parent and leaf nodes with path, active state and current schema version. Non-leaf or inactive nodes are informational and must not be selected for product submission. Revalidates the private representation on every request; a schema or category change produces a new ETag. Linear: REN2-59.' })
  @ApiExtension('x-renivet-permission', 'catalog.read')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOkResponse({ description: 'Paginated category tree. Cache-Control is private, no-cache; ETag covers this page and its cursor.', type: PagedCategoriesDto, headers: { 'Cache-Control': { schema: { type: 'string', example: 'private, no-cache' } }, ETag: { schema: { type: 'string', example: '"sha256-hex"' } } } })
  @ApiResponse({ status: 304, description: 'The page representation is unchanged for the supplied If-None-Match.' })
  @ApiHeader({ name: 'If-None-Match', required: false, schema: { type: 'string' }, description: 'Revalidate a previously returned page ETag.' })
  @ApiResponse({ status: 400, description: 'Invalid category cursor or page size.', type: CategoryReadErrorDto })
  @ApiServiceUnavailableResponse({ description: 'Taxonomy read storage is unavailable.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 401, description: 'Authentication is required.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 403, description: 'Brand permission denied.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 404, description: 'Brand or category resource was not found.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 409, description: 'Category state prevents the requested read.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 422, description: 'The supplied category query is invalid.', type: CategoryReadErrorDto })
  async listCategories(
    @Param('brandId') _brandId: string,
    @Query() query: TaxonomyPageQuery,
    @Req() request: BrandAccessRequest,
    @Headers('if-none-match') ifNoneMatch: string | string[] | undefined,
    @Res({ passthrough: true }) response: ReadResponse,
  ): Promise<Record<string, unknown> | undefined> {
    const value = await this.catalog.listCategories(request.brandAccess!, query);
    return this.cached(value, ifNoneMatch, response);
  }

  @Get(':categoryId/attributes')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiParam({ name: 'categoryId', format: 'uuid' })
  @ApiQuery({ name: 'cursor', required: false, type: 'string' })
  @ApiQuery({ name: 'limit', required: false, type: 'integer', minimum: 1, maximum: 100, default: 25 })
  @ApiOperation({ operationId: 'getCategoryAttributes', summary: 'Read the current published typed category attributes', description: 'Returns the immutable rules in the category current published schema snapshot. Pagination cursors are bound to that version and fail closed after a publish; use getCategorySchemaVersion for a specific historical version. Linear: REN2-59.' })
  @ApiExtension('x-renivet-permission', 'catalog.read')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOkResponse({ description: 'Paged typed attributes. Cache-Control is private, no-cache; ETag is version and page specific.', type: PagedAttributeDefinitionsDto, headers: { 'Cache-Control': { schema: { type: 'string', example: 'private, no-cache' } }, ETag: { schema: { type: 'string', example: '"sha256-hex"' } } } })
  @ApiResponse({ status: 304, description: 'The page representation is unchanged for the supplied If-None-Match.' })
  @ApiHeader({ name: 'If-None-Match', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 400, description: 'Invalid category identifier, cursor or page size.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 404, description: 'Category does not exist.', type: CategoryReadErrorDto })
  @ApiServiceUnavailableResponse({ description: 'Taxonomy read storage is unavailable.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 401, description: 'Authentication is required.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 403, description: 'Brand permission denied.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 409, description: 'Category state prevents the requested read.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 422, description: 'The supplied category query is invalid.', type: CategoryReadErrorDto })
  async getCategoryAttributes(
    @Param('brandId') _brandId: string,
    @Param('categoryId') categoryId: string,
    @Query() query: TaxonomyPageQuery,
    @Req() request: BrandAccessRequest,
    @Headers('if-none-match') ifNoneMatch: string | string[] | undefined,
    @Res({ passthrough: true }) response: ReadResponse,
  ): Promise<Record<string, unknown> | undefined> {
    const value = await this.catalog.getCategoryAttributes(request.brandAccess!, categoryId, query);
    return this.cached(value, ifNoneMatch, response);
  }

  @Get(':categoryId/schema-versions/:version')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiParam({ name: 'categoryId', format: 'uuid' })
  @ApiParam({ name: 'version', schema: { type: 'integer', minimum: 1 } })
  @ApiOperation({ operationId: 'getCategorySchemaVersion', summary: 'Read an exact published category schema version', description: 'Returns a historical published schema and its immutable typed rules without substituting the latest version. The ETag remains stable for this frozen snapshot. Linear: REN2-59.' })
  @ApiExtension('x-renivet-permission', 'catalog.read')
  @ApiExtension('x-renivet-guard', 'brand')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOkResponse({ description: 'Exact published category schema version.', type: CategorySchemaVersionReadDto, headers: { 'Cache-Control': { schema: { type: 'string', example: 'private, no-cache' } }, ETag: { schema: { type: 'string', example: '"sha256-hex"' } } } })
  @ApiResponse({ status: 304, description: 'The exact version representation is unchanged for the supplied If-None-Match.' })
  @ApiHeader({ name: 'If-None-Match', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 400, description: 'Invalid category identifier or version.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 404, description: 'Category or published schema version does not exist.', type: CategoryReadErrorDto })
  @ApiServiceUnavailableResponse({ description: 'Taxonomy read storage is unavailable.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 401, description: 'Authentication is required.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 403, description: 'Brand permission denied.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 409, description: 'Category state prevents the requested read.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 412, description: 'The selected schema version is stale.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 422, description: 'The supplied category or version is invalid.', type: CategoryReadErrorDto })
  async getCategorySchemaVersion(
    @Param('brandId') _brandId: string,
    @Param('categoryId') categoryId: string,
    @Param('version') version: string,
    @Req() request: BrandAccessRequest,
    @Headers('if-none-match') ifNoneMatch: string | string[] | undefined,
    @Res({ passthrough: true }) response: ReadResponse,
  ): Promise<Record<string, unknown> | undefined> {
    const value = await this.catalog.getCategorySchemaVersion(request.brandAccess!, categoryId, version);
    return this.cached(value, ifNoneMatch, response);
  }

  private cached(value: Record<string, unknown>, ifNoneMatch: string | string[] | undefined, response: ReadResponse): Record<string, unknown> | undefined {
    const etag = `"${createHash('sha256').update(JSON.stringify(value)).digest('hex')}"`;
    response.header('Cache-Control', 'private, no-cache').header('ETag', etag);
    const supplied = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch ?? '';
    const tags = supplied.split(',').map((tag) => tag.trim());
    if (tags.includes('*') || tags.some((tag) => tag.replace(/^W\//, '') === etag)) {
      response.code(304).send();
      return undefined;
    }
    return value;
  }
}
