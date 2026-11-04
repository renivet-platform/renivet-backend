import {
  Body, Controller, ForbiddenException, HttpCode, Headers, Param, Patch, Post, UnprocessableEntityException,
  Req, UseFilters, UseGuards, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiNotFoundResponse, ApiOperation,
  ApiParam, ApiResponse, ApiServiceUnavailableResponse, ApiTags, SchemaObject } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { CreateProductDraftDto, UpdateProductDraftDto } from './product-draft.dto';
import { ProductDraftService } from './product-draft.service';
import { ProductDraftExceptionFilter } from './product-draft-exception.filter';

interface ProductRequest extends BrandAccessRequest { id?: string; }
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,120}$/;
const createValidation = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
  exceptionFactory: () => new UnprocessableEntityException({ code: 'PRODUCT_DRAFT_INVALID', message: 'The product draft request is invalid.' }) });
const patchValidation = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
  exceptionFactory: () => new UnprocessableEntityException({ code: 'PRODUCT_DRAFT_INVALID', message: 'The product draft request is invalid.' }) });

const ERROR_SCHEMA = { type: 'object', required: ['code', 'message', 'requestId'], properties: {
  code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' },
  details: { type: 'object', additionalProperties: true },
} };
const MEDIA_LINK_SCHEMA = { type: 'object', required: ['id','mediaAssetId','productId','displayRole','displayOrder','scanState','rightsState'], properties: {
  id: { type: 'string', format: 'uuid' }, mediaAssetId: { type: 'string', format: 'uuid' }, productId: { type: 'string', format: 'uuid' },
  variantId: { type: 'string', format: 'uuid', nullable: true }, displayRole: { type: 'string' }, displayOrder: { type: 'integer', minimum: 0 },
  scanState: { type: 'string', enum: ['PENDING','CLEAN','REJECTED'] }, rightsState: { type: 'string', enum: ['UNVERIFIED','ATTESTED','REVIEWED','REVOKED'] },
} };
const PRICE_VERSION_SCHEMA = { type: 'object', required: ['id','variantId','currency','amountMinor','mrpMinor','priceState','validFrom'], properties: {
  id: { type: 'string', format: 'uuid' }, variantId: { type: 'string', format: 'uuid' }, currency: { type: 'string', const: 'INR' },
  amountMinor: { type: 'integer', minimum: 0 }, mrpMinor: { type: 'integer', minimum: 1 },
  priceState: { type: 'string', enum: ['DRAFT','PENDING','APPROVED','REJECTED','EXPIRED'] }, validFrom: { type: 'string', format: 'date-time' },
  validTo: { type: 'string', format: 'date-time', nullable: true }, rowVersion: { type: 'integer', minimum: 1 },
} };
const VARIANT_DETAIL_SCHEMA = { type: 'object', required: ['id','productId','brandId','sku','options','variantState'], additionalProperties: false, properties: {
  id: { type: 'string', format: 'uuid' }, productId: { type: 'string', format: 'uuid' }, brandId: { type: 'string', format: 'uuid' }, sku: { type: 'string' },
  options: { type: 'object', additionalProperties: { type: 'string' } }, variantState: { type: 'string' },
  priceVersions: { type: 'array', items: PRICE_VERSION_SCHEMA }, mediaLinks: { type: 'array', items: MEDIA_LINK_SCHEMA },
} };

@ApiTags('Catalog')
@ApiCookieAuth('renivetSession')
@Controller('brands/:brandId/products')
@UseGuards(BrandAccessGuard)
@UseFilters(ProductDraftExceptionFilter)
export class ProductDraftController {
  constructor(private readonly products: ProductDraftService, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Post()
  @HttpCode(201)
  @UsePipes(createValidation)
  @RequireBrandPermission('catalog.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'catalog.write')
  @ApiExtension('x-renivet-csrf-policy', 'Allowlisted origin, same-origin fetch metadata and W1 session-bound X-CSRF-Token; live brand permission and approved brand checked again in transaction.')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOperation({ operationId: 'createBrandProduct', summary: 'Create a progressive parent product draft', description: 'Creates an incomplete brand-owned draft with its immutable category schema pin; variants, price and media are not required until later workflow steps. Linear: REN2-61.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiBody({ schema: { type: 'object', required: ['styleCode', 'categoryCode', 'categorySchemaVersion', 'title'], additionalProperties: false,
    properties: { styleCode: { type: 'string', minLength: 1 }, categoryCode: { type: 'string' }, categorySchemaVersion: { type: 'integer', minimum: 1 }, title: { type: 'string', minLength: 1 }, description: { type: 'string' }, attributes: { type: 'object', additionalProperties: true }, variants: { type: 'array', minItems: 0, items: { type: 'object', required: ['sku', 'options'], additionalProperties: false, properties: { sku: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[A-Za-z0-9_.-]+$' }, options: { type: 'object', additionalProperties: { type: 'string' } }, weightG: { type: 'integer', minimum: 0 } } } } } } })
  @ApiResponse({ status: 201, description: 'Draft created.', schema: ({ type: 'object', required: ['productId','publicationState','contentVersion','qcState','categorySchemaVersion'], properties: { productId: { type: 'string', format: 'uuid' }, publicationState: { type: 'string', const: 'DRAFT' }, contentVersion: { type: 'integer', const: 1 }, rowVersion: { type: 'integer', const: 1 }, variantIds: { type: 'array', items: { type: 'string', format: 'uuid' } }, qcState: { type: 'string', const: 'NOT_SUBMITTED' }, categorySchemaVersion: { type: 'integer', minimum: 1 } } } as unknown as SchemaObject) })
  @ApiResponse({ status: 401, description: 'Missing or invalid first-party session.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission or CSRF denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'Brand was not found.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Duplicate style or changed idempotent replay.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'Brand state, category or attributes prevent this draft.', schema: ERROR_SCHEMA })
  @ApiServiceUnavailableResponse({ description: 'Product draft storage is unavailable.', schema: ERROR_SCHEMA })
  async create(@Body() body: CreateProductDraftDto, @Req() request: ProductRequest, @Headers('Idempotency-Key') key?: string) {
    const context = await this.mutationContext(request, key, 'create');
    return this.products.create(body, context);
  }

  @Patch(':productId')
  @UsePipes(patchValidation)
  @RequireBrandPermission('catalog.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'productId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'catalog.write')
  @ApiExtension('x-renivet-csrf-policy', 'Allowlisted origin, same-origin fetch metadata and W1 session-bound X-CSRF-Token; live brand permission and approved brand checked again in transaction.')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOperation({ operationId: 'updateBrandProduct', summary: 'Update a progressive product draft', description: 'Saves normalized draft fields with a row-version If-Match compare-and-swap. Historical published category schema versions remain valid pins. Linear: REN2-61.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiHeader({ name: 'If-Match', required: true, schema: { type: 'string', example: '"1"' }, description: 'Quoted rowVersion returned in ProductDetail.' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, minProperties: 1, properties: { title: { type: 'string' }, description: { type: 'string' }, categorySchemaVersion: { type: 'integer', minimum: 1 }, attributes: { type: 'object', additionalProperties: true } } } })
  @ApiResponse({ status: 200, description: 'Draft updated.', schema: { allOf: [
    { type: 'object', required: ['id','brandId','styleCode','title','publicationState','contentVersion'], properties: { id: { type: 'string', format: 'uuid' }, brandId: { type: 'string', format: 'uuid' }, styleCode: { type: 'string' }, title: { type: 'string' }, publicationState: { type: 'string', enum: ['DRAFT','INCOMPLETE','PENDING_REVIEW','APPROVED','PUBLISHED','RE_REVIEW','REJECTED','RESTRICTED','ARCHIVED'] }, contentVersion: { type: 'integer', minimum: 1 } } },
    { type: 'object', required: ['categoryId','categorySchemaVersion','rowVersion','variants','mediaLinks','attributes','qcState'], properties: {
      categoryId: { type: 'string', format: 'uuid' }, categorySchemaVersion: { type: 'integer', minimum: 1 }, rowVersion: { type: 'integer', minimum: 1 }, qcState: { type: 'string' },
      draftRevisionId: { type: 'string', format: 'uuid', nullable: true }, publishedRevisionId: { type: 'string', format: 'uuid', nullable: true }, approvedReviewId: { type: 'string', format: 'uuid', nullable: true },
      variants: { type: 'array', items: VARIANT_DETAIL_SCHEMA },
      mediaLinks: { type: 'array', items: MEDIA_LINK_SCHEMA }, attributes: { type: 'object', additionalProperties: true },
    } },
  ] } })
  @ApiResponse({ status: 401, description: 'Missing or invalid first-party session.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission or CSRF denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'Product was not found in this brand.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Stale row version, duplicate style or changed idempotent replay.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'Brand state, category, attributes or product state prevent the update.', schema: ERROR_SCHEMA })
  @ApiServiceUnavailableResponse({ description: 'Product draft storage is unavailable.', schema: ERROR_SCHEMA })
  async update(@Param('productId') productId: string, @Body() body: UpdateProductDraftDto, @Req() request: ProductRequest,
    @Headers('Idempotency-Key') key?: string, @Headers('If-Match') ifMatch?: string | string[]) {
    const context = await this.mutationContext(request, key, 'update');
    return this.products.update(productId, body, ifMatch, context);
  }

  private async mutationContext(request: ProductRequest, key: string | undefined, action: string) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) throw new UnprocessableEntityException({ code: 'PRODUCT_DRAFT_INVALID', message: 'The product draft request is invalid.' });
    const token = readSessionToken(request.headers.cookie);
    const session = await this.sessions.authenticate(token);
    const allowedOrigins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!token || !csrfMatches(request.headers, allowedOrigins, this.sessions.expectedCsrf(token))) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    const access = request.brandAccess!;
    return { userId: session.userId, brandId: access.brandId, permission: access.permission,
      requestId: request.id ?? `${action}:${key}`, idempotencyKey: key, sourceKind: 'MANUAL' as const, sourceReference: null };
  }
}
