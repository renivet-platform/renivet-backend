import { createHash } from 'node:crypto';
import { Controller, Get, Headers, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiExtension, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiServiceUnavailableResponse, ApiTags, ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { CategoryReadErrorDto } from './catalog-read.dto';
import { ProductListQuery, ProductReadService } from './product-read.service';

interface ReadResponse { header(name: string, value: string): this; code(status: number): this; send(body?: unknown): unknown; }
class ProductSummaryModel {
  @ApiProperty({ format: 'uuid' }) id!: string; @ApiProperty({ format: 'uuid' }) brandId!: string; @ApiProperty() styleCode!: string;
  @ApiProperty() title!: string; @ApiProperty({ enum: ['DRAFT','INCOMPLETE','PENDING_REVIEW','APPROVED','PUBLISHED','RE_REVIEW','REJECTED','RESTRICTED','ARCHIVED'] }) publicationState!: string; @ApiProperty({ type: 'integer', minimum: 1 }) contentVersion!: number;
}
class PriceVersionModel {
  @ApiProperty({ format: 'uuid' }) id!: string; @ApiProperty({ format: 'uuid' }) variantId!: string; @ApiProperty({ type: 'string', enum: ['INR'] }) currency!: string;
  @ApiProperty({ type: 'integer', minimum: 0 }) amountMinor!: number; @ApiProperty({ type: 'integer', minimum: 1 }) mrpMinor!: number; @ApiProperty({ enum: ['DRAFT','PENDING','APPROVED','REJECTED','EXPIRED'] }) priceState!: string;
  @ApiProperty({ format: 'date-time' }) validFrom!: string; @ApiProperty({ type: 'string', format: 'date-time', nullable: true, required: false }) validTo?: string | null; @ApiProperty({ type: 'integer', minimum: 1, required: false }) rowVersion?: number;
}
class MediaLinkModel {
  @ApiProperty({ format: 'uuid' }) id!: string; @ApiProperty({ format: 'uuid' }) mediaAssetId!: string; @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, required: false }) variantId?: string | null; @ApiProperty() displayRole!: string; @ApiProperty({ type: 'integer', minimum: 0 }) displayOrder!: number;
  @ApiProperty({ enum: ['PENDING','CLEAN','REJECTED'] }) scanState!: string; @ApiProperty({ enum: ['UNVERIFIED','ATTESTED','REVIEWED','REVOKED'] }) rightsState!: string;
}
@ApiTags('Catalog')
@ApiCookieAuth('sessionCookie')
@Controller('brands/:brandId/products')
@UseGuards(BrandAccessGuard)
@RequireBrandPermission('catalog.read')
@ApiExtraModels(ProductSummaryModel, PriceVersionModel, MediaLinkModel)
export class ProductReadController {
  constructor(private readonly products: ProductReadService) {}

  @Get()
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiQuery({ name: 'cursor', required: false, type: 'string' })
  @ApiQuery({ name: 'limit', required: false, type: 'integer', minimum: 1, maximum: 100, default: 25 })
  @ApiQuery({ name: 'categoryId', required: false, type: 'string', format: 'uuid' })
  @ApiQuery({ name: 'reviewState', required: false, type: 'string', enum: ['NOT_SUBMITTED','DRAFT','SUBMITTED','APPROVED','REJECTED','SUPERSEDED'] })
  @ApiQuery({ name: 'visibility', required: false, type: 'string', enum: ['PUBLIC','PRIVATE','RESTRICTED'] })
  @ApiOperation({ operationId: 'listBrandProducts', summary: 'List complete product summaries within the authorized brand', description: 'Filters the authorized brand product list, returns a brand-scoped total count and deterministic cursor pagination. Revalidates the private representation with ETag. Linear: REN2-70.' })
  @ApiExtension('x-renivet-permission', 'catalog.read') @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: false, required: ['items','totalCount'], properties: { items: { type: 'array', items: { $ref: getSchemaPath(ProductSummaryModel) } }, totalCount: { type: 'integer', minimum: 0 }, nextCursor: { type: 'string', nullable: true } } }, headers: { 'Cache-Control': { schema: { type: 'string' } }, ETag: { schema: { type: 'string' } } } })
  @ApiHeader({ name: 'If-None-Match', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 304, description: 'The scoped product page is unchanged.' })
  @ApiResponse({ status: 400, description: 'Invalid filter, cursor or page size.', type: CategoryReadErrorDto })
  @ApiResponse({ status: 401, description: 'Authentication is required.', type: CategoryReadErrorDto }) @ApiResponse({ status: 403, description: 'Brand permission denied.', type: CategoryReadErrorDto }) @ApiResponse({ status: 404, description: 'Brand resource was not found.', type: CategoryReadErrorDto }) @ApiResponse({ status: 409, description: 'Product state prevents the requested read.', type: CategoryReadErrorDto }) @ApiResponse({ status: 422, description: 'The product query is invalid.', type: CategoryReadErrorDto }) @ApiServiceUnavailableResponse({ description: 'Product storage is unavailable.', type: CategoryReadErrorDto })
  async listProducts(@Param('brandId') _brandId: string, @Query() query: ProductListQuery, @Req() request: BrandAccessRequest,
    @Headers('if-none-match') ifNoneMatch: string | string[] | undefined, @Res({ passthrough: true }) response: ReadResponse): Promise<Record<string, unknown> | undefined> {
    return this.cached(await this.products.list(request.brandAccess!, query), ifNoneMatch, response);
  }

  @Get(':productId')
  @ApiParam({ name: 'brandId', format: 'uuid' }) @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiOperation({ operationId: 'getBrandProduct', summary: 'Read a complete brand product and draft status', description: 'Returns versioned product, typed attributes, variants, price states and active media links without moderation evidence. Linear: REN2-70.' })
  @ApiExtension('x-renivet-permission', 'catalog.read') @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOkResponse({ schema: { allOf: [
    { $ref: getSchemaPath(ProductSummaryModel) },
    { type: 'object', required: ['categoryId','categorySchemaVersion','rowVersion','variants','mediaLinks','attributes','qcState'], properties: {
      categoryId: { type: 'string', format: 'uuid' }, categorySchemaVersion: { type: 'integer', minimum: 1 }, rowVersion: { type: 'integer', minimum: 1 }, qcState: { type: 'string' },
      draftRevisionId: { type: 'string', nullable: true, format: 'uuid' }, publishedRevisionId: { type: 'string', nullable: true, format: 'uuid' }, approvedReviewId: { type: 'string', nullable: true, format: 'uuid' },
      variants: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id','productId','brandId','sku','options','variantState'], properties: {
        id: { type: 'string', format: 'uuid' }, productId: { type: 'string', format: 'uuid' }, brandId: { type: 'string', format: 'uuid' }, sku: { type: 'string' },
        options: { type: 'object', additionalProperties: { type: 'string' } }, variantState: { type: 'string' },
        priceVersions: { type: 'array', items: { $ref: getSchemaPath(PriceVersionModel) } }, mediaLinks: { type: 'array', items: { $ref: getSchemaPath(MediaLinkModel) } },
      } } }, mediaLinks: { type: 'array', items: { $ref: getSchemaPath(MediaLinkModel) } }, attributes: { type: 'object', additionalProperties: true },
    } },
  ] }, headers: { 'Cache-Control': { schema: { type: 'string' } }, ETag: { schema: { type: 'string' } } } })
  @ApiHeader({ name: 'If-None-Match', required: false, schema: { type: 'string' } }) @ApiResponse({ status: 304, description: 'The scoped product representation is unchanged.' })
  @ApiResponse({ status: 400, description: 'Invalid product identifier.', type: CategoryReadErrorDto }) @ApiResponse({ status: 401, description: 'Authentication is required.', type: CategoryReadErrorDto }) @ApiResponse({ status: 403, description: 'Brand permission denied.', type: CategoryReadErrorDto }) @ApiResponse({ status: 404, description: 'Product was not found in the authorized brand.', type: CategoryReadErrorDto }) @ApiResponse({ status: 409, description: 'Product state prevents the requested read.', type: CategoryReadErrorDto }) @ApiResponse({ status: 422, description: 'The product identifier is invalid.', type: CategoryReadErrorDto }) @ApiServiceUnavailableResponse({ description: 'Product storage is unavailable.', type: CategoryReadErrorDto })
  async getProduct(@Param('brandId') _brandId: string, @Param('productId') productId: string, @Req() request: BrandAccessRequest,
    @Headers('if-none-match') ifNoneMatch: string | string[] | undefined, @Res({ passthrough: true }) response: ReadResponse): Promise<Record<string, unknown> | undefined> {
    return this.cached(await this.products.get(request.brandAccess!, productId), ifNoneMatch, response);
  }

  private cached(value: Record<string, unknown>, ifNoneMatch: string | string[] | undefined, response: ReadResponse): Record<string, unknown> | undefined {
    const etag = `"${createHash('sha256').update(JSON.stringify(value)).digest('hex')}"`;
    response.header('Cache-Control', 'private, no-cache').header('ETag', etag);
    const supplied = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch ?? '';
    if (supplied.split(',').some((tag) => ['*', etag].includes(tag.trim().replace(/^W\//, '')))) { response.code(304).send(); return undefined; }
    return value;
  }
}
