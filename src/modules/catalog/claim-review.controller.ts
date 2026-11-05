import { Body, Controller, ForbiddenException, Headers, HttpCode, Param, Post, Req, UnprocessableEntityException, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { MfaGuard, RequireMfa } from '../../common/guards/require-mfa';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { ClaimDecisionContext, ClaimsService } from './claims.service';
import { ClaimsExceptionFilter } from './claims-exception.filter';

interface ClaimReviewRequest extends BrandAccessRequest { readonly id?: string; }

const KEY = /^[A-Za-z0-9._:-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECISION_SCHEMA = {
  type: 'object', required: ['decision', 'reasonCode'], properties: {
    decision: { type: 'string', enum: ['VERIFY', 'REJECT', 'REVOKE'] },
    reasonCode: { type: 'string' }, comment: { type: 'string' },
  },
};
const ACTION_RECEIPT = { type: 'object', required: ['id', 'status', 'requestId'], properties: {
  id: { type: 'string', format: 'uuid' }, status: { type: 'string' }, requestId: { type: 'string' },
  rowVersion: { type: 'integer', minimum: 1 },
} };
const CLAIM_ERROR = { type: 'object', required: ['code', 'message', 'requestId'], properties: {
  code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: { type: 'object', additionalProperties: true },
} };

@ApiTags('Review')
@ApiCookieAuth('sessionCookie')
@Controller('admin/brands/:brandId/claims/:claimId/decision')
@UseGuards(BrandAccessGuard, MfaGuard)
@UseFilters(ClaimsExceptionFilter)
export class ClaimReviewController {
  constructor(private readonly claims: ClaimsService, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Post()
  @HttpCode(200)
  @RequireBrandPermission('catalog.review')
  @RequireMfa('catalog.review')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'claimId', type: 'string', format: 'uuid' })
  @ApiOperation({ operationId: 'decideProductClaim', summary: 'Approve, reject, or revoke a sustainability claim',
    description: 'Requires the platform-global catalog.review permission, a recent MFA step-up and session-bound CSRF. A distinct reviewer compares claim/evidence expiry and current asset eligibility, then commits the claim decision, immutable audit, listing recheck outbox event and idempotency receipt atomically. Linear: REN2-69.' })
  @ApiExtension('x-renivet-permission', 'catalog.review')
  @ApiExtension('x-renivet-guard', 'brand')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-mfa-required', true)
  @ApiExtension('x-renivet-csrf-policy', 'Require allowlisted Origin, Sec-Fetch-Site and X-CSRF-Token bound to W1 session; global permission rechecked in the database transaction.')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiHeader({ name: 'If-Match', required: true, schema: { type: 'string', example: '"1"' } })
  @ApiBody({ schema: DECISION_SCHEMA })
  @ApiOkResponse({ description: 'Claim decision receipt.', schema: ACTION_RECEIPT })
  @ApiResponse({ status: 401, description: 'Authentication is required.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 403, description: 'Global reviewer permission, maker-checker, MFA, or CSRF denied.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 404, description: 'The claim is not accessible.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 409, description: 'The claim is not in a reviewable state or the idempotency key conflicts.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 412, description: 'The claim row version is stale.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 422, description: 'The decision request is invalid.', schema: CLAIM_ERROR })
  @ApiServiceUnavailableResponse({ description: 'Claim or authentication storage is unavailable.', schema: CLAIM_ERROR })
  async decide(@Param('brandId') brandId: string, @Param('claimId') claimId: string, @Body() body: unknown,
    @Req() request: ClaimReviewRequest, @Headers('Idempotency-Key') key?: string,
    @Headers('If-Match') ifMatch?: string | string[]): Promise<Record<string, unknown>> {
    if (!UUID.test(brandId) || !UUID.test(claimId) || request.brandAccess?.brandId !== brandId) throw new UnprocessableEntityException({ code: 'CLAIM_REQUEST_INVALID', message: 'The claim request is invalid.' });
    if (!key || !KEY.test(key)) throw new UnprocessableEntityException({ code: 'CLAIM_REQUEST_INVALID', message: 'A valid idempotency key is required.' });
    const token = readSessionToken(request.headers.cookie);
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!token || !csrfMatches(request.headers, origins, this.sessions.expectedCsrf(token))) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    const context: ClaimDecisionContext = { userId: session.userId, brandId: request.brandAccess.brandId, permission: 'catalog.review',
      requestId: request.id ?? `claim-review:${key}`, idempotencyKey: key };
    const result = await this.claims.decide(claimId, body, ifMatch, context);
    return { id: result.id, status: result.claimState, requestId: result.requestId, rowVersion: result.rowVersion };
  }
}
