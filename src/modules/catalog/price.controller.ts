import {
  Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Patch, Req, UnprocessableEntityException,
  UseFilters, UseGuards,
} from '@nestjs/common';
import {
  ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiResponse,
  ApiServiceUnavailableResponse, ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ConfigService } from '@nestjs/config';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { PriceErrorDto, PriceActionReceiptDto } from './price.dto';
import { PriceExceptionFilter } from './price-exception.filter';
import { PriceMutationContext, PriceReadContext, PriceService } from './price.service';

interface PriceRequest extends BrandAccessRequest { id?: string; }
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,120}$/;
const PRICE_PROPOSAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['currency', 'sellingPriceMinor', 'mrpMinor', 'validFrom', 'ruleVersion'],
  properties: {
    currency: { type: 'string', const: 'INR' },
    sellingPriceMinor: { type: 'integer', minimum: 0 },
    mrpMinor: { type: 'integer', minimum: 1 },
    validFrom: { type: 'string', format: 'date-time' },
    validTo: { type: ['string', 'null'], format: 'date-time' },
    ruleVersion: { type: 'integer', minimum: 1 },
    reasonCode: { type: 'string' },
  },
};

@ApiTags('Pricing')
@ApiCookieAuth('renivetSession')
@Controller('brands/:brandId/variants/:variantId/prices')
@UseGuards(BrandAccessGuard)
@UseFilters(PriceExceptionFilter)
export class PriceController {
  constructor(private readonly prices: PriceService, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Patch()
  @HttpCode(202)
  @RequireBrandPermission('pricing.write')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOperation({ operationId: 'proposeVariantPrice', summary: 'Propose a versioned INR price for a brand-owned variant', description: 'Creates an immutable pending price proposal. The current variant row version is checked with If-Match; approval is a separate REN2-65 reviewer action. Linear: REN2-64.' })
  @ApiExtension('x-renivet-permission', 'pricing.write')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-csrf-policy', 'W1 validateCsrfRequest: allowlisted Origin, sec-fetch-site same-origin, x-csrf-token session-bound; permission and MFA still required')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiHeader({ name: 'If-Match', required: true, schema: { type: 'string', example: '"1"' } })
  @ApiBody({ schema: PRICE_PROPOSAL_SCHEMA })
  @ApiResponse({ status: 202, description: 'Versioned outcome / accepted command.', type: PriceActionReceiptDto })
  @ApiResponse({ status: 401, description: 'Authentication is required.', type: PriceErrorDto })
  @ApiResponse({ status: 403, description: 'Brand permission or CSRF denied.', type: PriceErrorDto })
  @ApiResponse({ status: 404, description: 'Brand or variant resource was not found.', type: PriceErrorDto })
  @ApiResponse({ status: 409, description: 'Stale version, idempotency conflict or approved-price overlap.', type: PriceErrorDto })
  @ApiResponse({ status: 422, description: 'The price proposal is invalid.', type: PriceErrorDto })
  @ApiServiceUnavailableResponse({ description: 'Price storage is unavailable.', type: PriceErrorDto })
  async propose(@Param('brandId') _brandId: string, @Param('variantId') variantId: string, @Body() body: unknown,
    @Req() request: PriceRequest, @Headers('Idempotency-Key') key?: string,
    @Headers('If-Match') ifMatch?: string | string[]): Promise<Record<string, unknown>> {
    const context = await this.mutationContext(request, key);
    return this.prices.propose(variantId, body, ifMatch, context);
  }

  @Get()
  @RequireBrandPermission('pricing.read')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOperation({ operationId: 'listVariantPrices', summary: 'List price history for a brand-owned variant', description: 'Returns all price versions for a brand-owned variant after rechecking live W1 pricing.read permission in the scoped query. Linear: REN2-64.' })
  @ApiExtension('x-renivet-permission', 'pricing.read')
  @ApiExtension('x-renivet-guard', 'brand')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOkResponse({
    description: 'Price history for the authorized variant.',
    schema: {
      type: 'object', required: ['items'],
      properties: {
        items: { type: 'array', items: { type: 'object', required: ['id', 'variantId', 'currency', 'amountMinor', 'mrpMinor', 'priceState', 'validFrom'], properties: {
          id: { type: 'string', format: 'uuid' }, variantId: { type: 'string', format: 'uuid' }, currency: { type: 'string', const: 'INR' },
          amountMinor: { type: 'integer', minimum: 0 }, mrpMinor: { type: 'integer', minimum: 1 },
          priceState: { type: 'string', enum: ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] },
          validFrom: { type: 'string', format: 'date-time' }, validTo: { type: ['string', 'null'], format: 'date-time' },
          rowVersion: { type: 'integer', minimum: 1 },
        } } },
        nextCursor: { type: ['string', 'null'] },
      },
    } as unknown as SchemaObject,
  })
  @ApiResponse({ status: 400, description: 'The price query is invalid.', type: PriceErrorDto })
  @ApiResponse({ status: 401, description: 'Authentication is required.', type: PriceErrorDto })
  @ApiResponse({ status: 403, description: 'Brand permission denied.', type: PriceErrorDto })
  @ApiResponse({ status: 404, description: 'Brand or variant resource was not found.', type: PriceErrorDto })
  @ApiResponse({ status: 409, description: 'Price history cannot be returned in the current state.', type: PriceErrorDto })
  @ApiResponse({ status: 412, description: 'The supplied resource version does not match.', type: PriceErrorDto })
  @ApiResponse({ status: 422, description: 'The price query is invalid.', type: PriceErrorDto })
  @ApiServiceUnavailableResponse({ description: 'Price storage is unavailable.', type: PriceErrorDto })
  async list(@Param('brandId') _brandId: string, @Param('variantId') variantId: string,
    @Req() request: PriceRequest): Promise<Record<string, unknown>> {
    return this.prices.list(variantId, this.readContext(request));
  }

  private async mutationContext(request: PriceRequest, key: string | undefined): Promise<PriceMutationContext> {
    if (!key || !IDEMPOTENCY_KEY.test(key)) throw new UnprocessableEntityException({ code: 'PRICE_REQUEST_INVALID', message: 'A valid idempotency key is required.' });
    const token = readSessionToken(request.headers.cookie);
    const session = await this.sessions.authenticate(token);
    const allowedOrigins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!token || !csrfMatches(request.headers, allowedOrigins, this.sessions.expectedCsrf(token))) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    const access = request.brandAccess!;
    return { userId: session.userId, brandId: access.brandId, permission: 'pricing.write',
      requestId: request.id ?? `price:${key}`, idempotencyKey: key };
  }

  private readContext(request: PriceRequest): PriceReadContext {
    return { userId: request.brandAccess!.userId, brandId: request.brandAccess!.brandId, permission: 'pricing.read' };
  }
}
