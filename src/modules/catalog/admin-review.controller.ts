import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiExtension, ApiOkResponse, ApiOperation, ApiParam, ApiPropertyOptional, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PlatformPermissionGuard, RequirePlatformAdminPermission } from '../access/platform-permission.guard';
import { AdminReviewQueue, AdminReviewReadRepository } from './admin-review.repository';

interface ReviewRequest { platformPermission?: { userId: string; permission: string }; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AdminReviewItemDto {
  @ApiPropertyOptional({ format: 'uuid' }) brandId?: string;
  @ApiPropertyOptional() brandName?: string;
  @ApiPropertyOptional({ format: 'uuid' }) productId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) revisionId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) priceId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) claimId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) categoryId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) approvalId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) submittedBy?: string;
  @ApiPropertyOptional({ format: 'uuid' }) approvedBy?: string;
  @ApiPropertyOptional() title?: string;
  @ApiPropertyOptional() status?: string;
  @ApiPropertyOptional() publicationState?: string;
  @ApiPropertyOptional() styleCode?: string;
  @ApiPropertyOptional() categoryCode?: string;
  @ApiPropertyOptional() categoryLabel?: string;
  @ApiPropertyOptional() claimText?: string;
  @ApiPropertyOptional() sku?: string;
  @ApiPropertyOptional() isLeaf?: boolean;
  @ApiPropertyOptional() retired?: boolean;
  @ApiPropertyOptional() active?: boolean;
  @ApiPropertyOptional() claimCode?: string;
  @ApiPropertyOptional() reasonCode?: string;
  @ApiPropertyOptional() currency?: string;
  @ApiPropertyOptional({ type: 'integer' }) rowVersion?: number;
  @ApiPropertyOptional({ type: 'integer' }) contentVersion?: number;
  @ApiPropertyOptional({ type: 'integer' }) version?: number;
  @ApiPropertyOptional({ type: 'integer' }) amountMinor?: number;
  @ApiPropertyOptional({ type: 'integer' }) mrpMinor?: number;
  @ApiPropertyOptional({ type: 'integer' }) publicationVersion?: number;
  @ApiPropertyOptional({ type: 'string', format: 'date-time' }) submittedAt?: string;
  @ApiPropertyOptional({ type: 'string', format: 'date-time' }) expiresAt?: string | null;
  @ApiPropertyOptional({ type: 'string', format: 'date-time' }) validFrom?: string;
  @ApiPropertyOptional({ type: 'string', format: 'date-time' }) validTo?: string | null;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) snapshot?: Record<string, unknown>;
  @ApiPropertyOptional({ type: 'array', items: { type: 'object', additionalProperties: true } }) rules?: Record<string, unknown>[];
  @ApiPropertyOptional({ type: 'array', items: { type: 'object', additionalProperties: true } }) evidence?: Record<string, unknown>[];
  @ApiPropertyOptional({ type: 'array', items: { type: 'object', additionalProperties: true } }) media?: Record<string, unknown>[];
  @ApiPropertyOptional({ type: 'array', items: { type: 'object', additionalProperties: true } }) history?: Record<string, unknown>[];
}
class AdminReviewQueueResponseDto {
  @ApiPropertyOptional({ type: [AdminReviewItemDto] }) items!: AdminReviewItemDto[];
}

@ApiTags('Admin Review')
@ApiCookieAuth('renivetSession')
@Controller('admin/reviews')
@UseGuards(PlatformPermissionGuard)
export class AdminReviewController {
  constructor(private readonly reviews: AdminReviewReadRepository) {}

  @Get('taxonomy')
  @RequirePlatformAdminPermission('taxonomy.approve')
  @ApiExtension('x-renivet-permission','taxonomy.approve')
  @ApiExtension('x-renivet-implementation-wave', 'W1')
  @ApiOperation({ operationId: 'listAdminTaxonomyReviews', summary: 'List persisted draft taxonomy revisions for global administrators' })
  @ApiOkResponse({ type: AdminReviewQueueResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: 'integer', minimum: 1, maximum: 100, default: 50 })
  taxonomy(@Query('limit') limit: string | undefined, @Req() request: ReviewRequest) { return this.reviews.list('taxonomy', this.actor(request), this.limit(limit)); }

  @Get('quality')
  @RequirePlatformAdminPermission('catalog.review')
  @ApiExtension('x-renivet-permission','catalog.review')
  @ApiExtension('x-renivet-implementation-wave', 'W1')
  @ApiOperation({ operationId: 'listAdminQcReviews', summary: 'List submitted frozen catalog revisions for global reviewers' })
  @ApiOkResponse({ type: AdminReviewQueueResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: 'integer', minimum: 1, maximum: 100, default: 50 })
  quality(@Query('limit') limit: string | undefined, @Req() request: ReviewRequest) { return this.reviews.list('quality', this.actor(request), this.limit(limit)); }

  @Get('pricing')
  @RequirePlatformAdminPermission('pricing.approve')
  @ApiExtension('x-renivet-permission','pricing.approve')
  @ApiExtension('x-renivet-implementation-wave', 'W1')
  @ApiOperation({ operationId: 'listAdminPriceReviews', summary: 'List pending price proposals for global administrators' })
  @ApiOkResponse({ type: AdminReviewQueueResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: 'integer', minimum: 1, maximum: 100, default: 50 })
  pricing(@Query('limit') limit: string | undefined, @Req() request: ReviewRequest) { return this.reviews.list('pricing', this.actor(request), this.limit(limit)); }

  @Get('claims')
  @RequirePlatformAdminPermission('catalog.review')
  @ApiExtension('x-renivet-permission','catalog.review')
  @ApiExtension('x-renivet-implementation-wave', 'W1')
  @ApiOperation({ operationId: 'listAdminClaimReviews', summary: 'List pending sustainability claims for global reviewers' })
  @ApiOkResponse({ type: AdminReviewQueueResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: 'integer', minimum: 1, maximum: 100, default: 50 })
  claims(@Query('limit') limit: string | undefined, @Req() request: ReviewRequest) { return this.reviews.list('claims', this.actor(request), this.limit(limit)); }

  @Get('publishing')
  @RequirePlatformAdminPermission('catalog.publish')
  @ApiExtension('x-renivet-permission','catalog.publish')
  @ApiExtension('x-renivet-implementation-wave', 'W1')
  @ApiOperation({ operationId: 'listAdminPublicationReviews', summary: 'List exactly approved revisions awaiting publication' })
  @ApiOkResponse({ type: AdminReviewQueueResponseDto })
  @ApiQuery({ name: 'limit', required: false, type: 'integer', minimum: 1, maximum: 100, default: 50 })
  publishing(@Query('limit') limit: string | undefined, @Req() request: ReviewRequest) { return this.reviews.list('publishing', this.actor(request), this.limit(limit)); }

  @Get('taxonomy/:id') @RequirePlatformAdminPermission('taxonomy.approve')
  @ApiExtension('x-renivet-permission','taxonomy.approve') @ApiExtension('x-renivet-implementation-wave', 'W1') @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ operationId: 'getAdminTaxonomyReview', summary: 'Read the exact draft category schema and diff inputs' })
  @ApiOkResponse({ type: AdminReviewItemDto })
  taxonomyDetail(@Param('id') id: string, @Req() request: ReviewRequest) { return this.detail('taxonomy', id, request); }

  @Get('quality/:id') @RequirePlatformAdminPermission('catalog.review')
  @ApiExtension('x-renivet-permission','catalog.review') @ApiExtension('x-renivet-implementation-wave', 'W1') @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ operationId: 'getAdminQcReview', summary: 'Read the exact submitted frozen revision and media evidence' })
  @ApiOkResponse({ type: AdminReviewItemDto })
  qualityDetail(@Param('id') id: string, @Req() request: ReviewRequest) { return this.detail('quality', id, request); }

  @Get('pricing/:id') @RequirePlatformAdminPermission('pricing.approve')
  @ApiExtension('x-renivet-permission','pricing.approve') @ApiExtension('x-renivet-implementation-wave', 'W1') @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ operationId: 'getAdminPriceReview', summary: 'Read the exact pending price proposal and price history' })
  @ApiOkResponse({ type: AdminReviewItemDto })
  pricingDetail(@Param('id') id: string, @Req() request: ReviewRequest) { return this.detail('pricing', id, request); }

  @Get('claims/:id') @RequirePlatformAdminPermission('catalog.review')
  @ApiExtension('x-renivet-permission','catalog.review') @ApiExtension('x-renivet-implementation-wave', 'W1') @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ operationId: 'getAdminClaimReview', summary: 'Read the exact pending sustainability claim and evidence metadata' })
  @ApiOkResponse({ type: AdminReviewItemDto })
  claimsDetail(@Param('id') id: string, @Req() request: ReviewRequest) { return this.detail('claims', id, request); }

  @Get('publishing/:id') @RequirePlatformAdminPermission('catalog.publish')
  @ApiExtension('x-renivet-permission','catalog.publish') @ApiExtension('x-renivet-implementation-wave', 'W1') @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ operationId: 'getAdminPublicationReview', summary: 'Read exact approved revision and separate QC approval evidence' })
  @ApiOkResponse({ type: AdminReviewItemDto })
  publishingDetail(@Param('id') id: string, @Req() request: ReviewRequest) { return this.detail('publishing', id, request); }

  @ApiResponse({ status: 404, description: 'Item not found in an authorized pending queue.' })
  private async detail(queue: AdminReviewQueue, id: string, request: ReviewRequest) {
    if (!UUID.test(id)) throw new NotFoundException({ code: 'ADMIN_REVIEW_NOT_FOUND', message: 'The review item was not found.' });
    const item = await this.reviews.detail(queue, id, this.actor(request));
    if (!item) throw new NotFoundException({ code: 'ADMIN_REVIEW_NOT_FOUND', message: 'The review item was not found.' });
    return item;
  }
  private actor(request: ReviewRequest): string { return request.platformPermission?.userId ?? ''; }
  private limit(raw?: string): number {
    if (raw === undefined) return 50;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : 50;
  }
}

