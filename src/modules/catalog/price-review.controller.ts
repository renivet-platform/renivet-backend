import {
  Body, Controller, ForbiddenException, Headers, HttpCode, Param, Post, Req, UnprocessableEntityException,
  UseFilters, UseGuards,
} from '@nestjs/common';
import {
  ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiResponse,
  ApiServiceUnavailableResponse, ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { RequireMfa, MfaGuard } from '../../common/guards/require-mfa';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { PriceActionReceiptDto, PriceErrorDto } from './price.dto';
import { PriceExceptionFilter } from './price-exception.filter';
import { PriceDecisionContext, PriceService } from './price.service';

interface ReviewRequest extends BrandAccessRequest { id?: string; }
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,120}$/;
const PRICE_DECISION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['decision', 'reasonCode'],
  properties: {
    decision: { type: 'string', enum: ['APPROVE', 'REJECT'] },
    reasonCode: { type: 'string' },
    comment: { type: 'string' },
    expectedState: { type: 'string', const: 'PENDING' },
  },
};

@ApiTags('Pricing')
@ApiCookieAuth('renivetSession')
@Controller('admin/brands/:brandId/variant-prices/:priceId/decision')
@UseGuards(BrandAccessGuard, MfaGuard)
@UseFilters(PriceExceptionFilter)
export class PriceReviewController {
  constructor(private readonly prices: PriceService, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Post()
  @HttpCode(200)
  @RequireBrandPermission('pricing.approve')
  @RequireMfa('pricing.approve')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiParam({ name: 'priceId', format: 'uuid' })
  @ApiOperation({ operationId: 'decideVariantPrice', summary: 'Approve or reject a pending brand price proposal', description: 'Requires current brand-scoped pricing.approve permission, a recent MFA step-up and session-bound CSRF. The price state compare-and-set, approval overlap constraint, audit event and idempotency receipt are committed together. Linear: REN2-65.' })
  @ApiExtension('x-renivet-permission', 'pricing.approve')
  @ApiExtension('x-renivet-guard', 'brand')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-mfa-required', true)
  @ApiExtension('x-renivet-csrf-policy', 'Require allowlisted Origin, Sec-Fetch-Site and X-CSRF-Token bound to W1 session; same-statement resource permission in W1.')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiBody({ schema: PRICE_DECISION_SCHEMA })
  @ApiOkResponse({ description: 'Price decision receipt.', type: PriceActionReceiptDto })
  @ApiResponse({ status: 400, description: 'The price decision request could not be parsed.', type: PriceErrorDto })
  @ApiResponse({ status: 401, description: 'Authentication is required.', type: PriceErrorDto })
  @ApiResponse({ status: 403, description: 'Brand permission, maker-checker or CSRF denied.', type: PriceErrorDto })
  @ApiResponse({ status: 404, description: 'The price proposal was not found in this brand.', type: PriceErrorDto })
  @ApiResponse({ status: 409, description: 'The proposal is no longer pending, an overlap exists or the idempotency key conflicts.', type: PriceErrorDto })
  @ApiResponse({ status: 412, description: 'The supplied expected state is stale.', type: PriceErrorDto })
  @ApiResponse({ status: 422, description: 'The price decision is invalid.', type: PriceErrorDto })
  @ApiServiceUnavailableResponse({ description: 'Price or authentication storage is unavailable.', type: PriceErrorDto })
  async decide(@Param('brandId') _brandId: string, @Param('priceId') priceId: string, @Body() body: unknown,
    @Req() request: ReviewRequest, @Headers('Idempotency-Key') key?: string): Promise<Record<string, unknown>> {
    if (!key || !IDEMPOTENCY_KEY.test(key)) throw new UnprocessableEntityException({ code: 'PRICE_REQUEST_INVALID', message: 'A valid idempotency key is required.' });
    const token = readSessionToken(request.headers.cookie);
    const session = await this.sessions.authenticate(token);
    const allowedOrigins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!token || !csrfMatches(request.headers, allowedOrigins, this.sessions.expectedCsrf(token))) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    const access = request.brandAccess!;
    const context: PriceDecisionContext = { userId: session.userId, brandId: access.brandId,
      permission: 'pricing.approve', requestId: request.id ?? `price-decision:${key}`, idempotencyKey: key };
    return this.prices.decide(priceId, body, context);
  }
}
