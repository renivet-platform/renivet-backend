import {
  Body, Controller, Delete, ForbiddenException, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req,
  UnprocessableEntityException, UseFilters, UseGuards, UsePipes, ValidationPipe,
} from '@nestjs/common';
import {
  ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiNotFoundResponse, ApiOperation, ApiParam, ApiResponse,
  ApiServiceUnavailableResponse, ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { MediaExceptionFilter } from './media-exception.filter';
import { AttachProductMediaDto, UpdateProductMediaDto } from './product-media.dto';
import { ProductMediaMutationContext, ProductMediaService } from './product-media.service';

interface ProductMediaRequest extends BrandAccessRequest { id?: string; }
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const VALIDATION = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
  exceptionFactory: () => new UnprocessableEntityException({ code: 'PRODUCT_MEDIA_INVALID', message: 'The media-link request is invalid.' }) });
const ERROR_SCHEMA = { type: 'object', required: ['code','message','requestId'], properties: {
  code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: { type: 'object', additionalProperties: true },
} };
const LINK_SCHEMA = { type: 'object', required: ['id','mediaAssetId','productId','displayRole','displayOrder','scanState','rightsState'], properties: {
  id: { type: 'string', format: 'uuid' }, mediaAssetId: { type: 'string', format: 'uuid' }, productId: { type: 'string', format: 'uuid' },
  variantId: { type: ['string','null'], format: 'uuid' }, displayRole: { type: 'string' }, displayOrder: { type: 'integer', minimum: 0 },
  scanState: { type: 'string', enum: ['PENDING','CLEAN','REJECTED'] },
  rightsState: { type: 'string', enum: ['UNVERIFIED','ATTESTED','REVIEWED','REVOKED'] },
} };
const RECEIPT_SCHEMA = { type: 'object', required: ['id','status','requestId'], properties: {
  id: { type: 'string', format: 'uuid' }, status: { type: 'string' }, requestId: { type: 'string' }, rowVersion: { type: 'integer', minimum: 1 },
} };

@ApiTags('Media')
@ApiCookieAuth('renivetSession')
@Controller('brands/:brandId/products/:productId/media')
@UseGuards(BrandAccessGuard)
@UseFilters(MediaExceptionFilter)
export class ProductMediaController {
  constructor(private readonly media: ProductMediaService, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Post()
  @HttpCode(201)
  @UsePipes(VALIDATION)
  @RequireBrandPermission('catalog.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' }) @ApiParam({ name: 'productId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'catalog.write') @ApiExtension('x-renivet-guard', 'brand')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-csrf-policy', 'Allowlisted Origin, same-origin fetch metadata and W1 session-bound X-CSRF-Token; live brand permission is rechecked in the database transaction.')
  @ApiOperation({ operationId: 'attachProductMedia', summary: 'Attach a clean brand-owned image to a product or exact variant', description: 'Adds a parent or variant image at the requested order; order 0 is the primary image for that target. Linear: REN2-67.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiBody({ type: AttachProductMediaDto })
  @ApiResponse({ status: 201, description: 'Image association created.', schema: LINK_SCHEMA })
  @ApiResponse({ status: 400, description: 'Malformed product or variant identifier.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 401, description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission or CSRF denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'Product, asset or variant is not accessible.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Duplicate link, stale product state or idempotency conflict.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 412, description: 'The supplied product row version is stale.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'Asset is not clean or request failed validation.', schema: ERROR_SCHEMA })
  @ApiServiceUnavailableResponse({ description: 'Media association storage is unavailable.', schema: ERROR_SCHEMA })
  async attach(@Param('productId', new ParseUUIDPipe()) productId: string, @Body() body: AttachProductMediaDto,
    @Req() request: ProductMediaRequest, @Headers('Idempotency-Key') key?: string) {
    return this.media.attach(productId, body, await this.mutationContext(request, key));
  }

  @Patch(':linkId')
  @HttpCode(200)
  @UsePipes(VALIDATION)
  @RequireBrandPermission('catalog.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' }) @ApiParam({ name: 'productId', type: 'string', format: 'uuid' }) @ApiParam({ name: 'linkId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'catalog.write') @ApiExtension('x-renivet-guard', 'brand')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-csrf-policy', 'Allowlisted Origin, same-origin fetch metadata and W1 session-bound X-CSRF-Token; live brand permission is rechecked in the database transaction.')
  @ApiOperation({ operationId: 'updateProductMediaLink', summary: 'Reorder or update a product image link', description: 'Uses the product row-version If-Match compare-and-swap; setting displayOrder to 0 makes the image primary within its parent or exact-variant gallery. Linear: REN2-67.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiHeader({ name: 'If-Match', required: true, schema: { type: 'string', example: '"1"' } })
  @ApiBody({ schema: { type: 'object', minProperties: 1, properties: {
    displayOrder: { type: 'integer', minimum: 0 }, displayRole: { type: 'string' }, altText: { type: 'string' },
  } } })
  @ApiResponse({ status: 200, description: 'Updated image association.', schema: LINK_SCHEMA })
  @ApiResponse({ status: 400, description: 'Malformed identifier.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 401, description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission or CSRF denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'Image association is not accessible.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Idempotency conflict or product state conflict.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 412, description: 'The supplied product row version is stale.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'Request failed validation.', schema: ERROR_SCHEMA })
  @ApiServiceUnavailableResponse({ description: 'Media association storage is unavailable.', schema: ERROR_SCHEMA })
  async update(@Param('productId', new ParseUUIDPipe()) productId: string, @Param('linkId', new ParseUUIDPipe()) linkId: string,
    @Body() body: UpdateProductMediaDto, @Req() request: ProductMediaRequest, @Headers('Idempotency-Key') key?: string,
    @Headers('If-Match') ifMatch?: string | string[]) {
    return this.media.update(productId, linkId, body, ifMatch, await this.mutationContext(request, key));
  }

  @Delete(':linkId')
  @HttpCode(200)
  @RequireBrandPermission('catalog.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' }) @ApiParam({ name: 'productId', type: 'string', format: 'uuid' }) @ApiParam({ name: 'linkId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'catalog.write') @ApiExtension('x-renivet-guard', 'brand')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-csrf-policy', 'Allowlisted Origin, same-origin fetch metadata and W1 session-bound X-CSRF-Token; live brand permission is rechecked in the database transaction.')
  @ApiOperation({ operationId: 'detachProductMedia', summary: 'Detach a product image without deleting its history', description: 'Soft-detaches the active image link with the product row-version If-Match and retains revision snapshots and audit history. Linear: REN2-67.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiHeader({ name: 'If-Match', required: true, schema: { type: 'string', example: '"1"' } })
  @ApiResponse({ status: 200, description: 'Image association detached.', schema: RECEIPT_SCHEMA })
  @ApiResponse({ status: 400, description: 'Malformed identifier.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 401, description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission or CSRF denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'Image association is not accessible.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Idempotency conflict or product state conflict.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 412, description: 'The supplied product row version is stale.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'Request failed validation.', schema: ERROR_SCHEMA })
  @ApiServiceUnavailableResponse({ description: 'Media association storage is unavailable.', schema: ERROR_SCHEMA })
  async detach(@Param('productId', new ParseUUIDPipe()) productId: string, @Param('linkId', new ParseUUIDPipe()) linkId: string,
    @Req() request: ProductMediaRequest, @Headers('Idempotency-Key') key?: string,
    @Headers('If-Match') ifMatch?: string | string[]) {
    return this.media.detach(productId, linkId, ifMatch, await this.mutationContext(request, key));
  }

  private async mutationContext(request: ProductMediaRequest, key: string | undefined): Promise<ProductMediaMutationContext> {
    if (!key || !KEY_PATTERN.test(key)) throw new UnprocessableEntityException({ code: 'PRODUCT_MEDIA_INVALID', message: 'A valid idempotency key is required.' });
    const token = readSessionToken(request.headers.cookie);
    if (!token) throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(request.headers, origins, this.sessions.expectedCsrf(token))) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    const access = request.brandAccess!;
    return { brandId: access.brandId, userId: session.userId, permission: 'catalog.write',
      requestId: request.id ?? `product-media:${key}`, idempotencyKey: key };
  }
}
