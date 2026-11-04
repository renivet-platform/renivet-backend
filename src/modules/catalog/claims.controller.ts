import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UnprocessableEntityException, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { ClaimsService, ClaimMutationContext, ClaimReadContext } from './claims.service';
import { ClaimsExceptionFilter } from './claims-exception.filter';

interface ClaimRequest extends BrandAccessRequest { id?: string; }
const CLAIM_ERROR = { type: 'object', required: ['code','message','requestId'], properties: {
  code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: { type: 'object', additionalProperties: true },
} };
const CLAIM_DETAIL = { type: 'object', required: ['id','productId','brandId','claimCode','claimText','claimState','evidenceAssetIds'], properties: {
  id: { type: 'string', format: 'uuid' }, productId: { type: 'string', format: 'uuid' }, brandId: { type: 'string', format: 'uuid' },
  claimCode: { type: 'string' }, claimText: { type: 'string' },
  claimState: { type: 'string', enum: ['PENDING','VERIFIED','REJECTED','EXPIRED','REVOKED'] },
  expiresAt: { type: ['string','null'], format: 'date-time' }, evidenceAssetIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
} };

@ApiTags('Review')
@ApiCookieAuth('renivetSession')
@Controller('brands/:brandId/products/:productId/claims')
@UseGuards(BrandAccessGuard)
@UseFilters(ClaimsExceptionFilter)
export class ClaimsController {
  constructor(private readonly claims: ClaimsService, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Post()
  @HttpCode(201)
  @RequireBrandPermission('catalog.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' }) @ApiParam({ name: 'productId', type: 'string', format: 'uuid' })
  @ApiOperation({ operationId: 'proposeProductClaim', summary: 'Submit a sustainability claim and evidence for independent review', description: 'Creates a pending claim for the product’s published revision. This operation cannot approve or verify the claim. Evidence IDs are brand-scoped; no private asset URL is returned. Linear: REN2-68.' })
  @ApiExtension('x-renivet-permission', 'catalog.write') @ApiExtension('x-renivet-guard', 'brand')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-csrf-policy', 'W1 session-bound X-CSRF-Token, allowlisted Origin and same-origin Sec-Fetch-Site; live permission is rechecked in the database transaction.')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiHeader({ name: 'If-Match', required: true, schema: { type: 'string', example: '"1"' } })
  @ApiBody({ schema: { type: 'object', required: ['claimCode','claimText','evidenceAssetIds'], properties: {
    claimCode: { type: 'string' }, claimText: { type: 'string' },
    evidenceAssetIds: { type: 'array', minItems: 1, items: { type: 'string', format: 'uuid' } },
    expiresAt: { type: ['string','null'], format: 'date-time' },
  } } })
  @ApiResponse({ status: 201, description: 'Claim submitted for independent review.', schema: CLAIM_DETAIL })
  @ApiResponse({ status: 401, description: 'Authentication is required.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 403, description: 'Brand permission or CSRF denied.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 404, description: 'Product or evidence is not accessible.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 409, description: 'Version or idempotency conflict.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 412, description: 'Product row version changed.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 422, description: 'Claim request failed validation.', schema: CLAIM_ERROR })
  @ApiServiceUnavailableResponse({ description: 'Claim storage is unavailable.', schema: CLAIM_ERROR })
  async propose(@Param('productId', new ParseUUIDPipe()) productId: string, @Body() body: unknown,
    @Req() request: ClaimRequest, @Headers('Idempotency-Key') key?: string,
    @Headers('If-Match') ifMatch?: string | string[]): Promise<Record<string, unknown>> {
    return this.claims.propose(productId, body, ifMatch, await this.mutationContext(request, key));
  }

  @Get()
  @RequireBrandPermission('catalog.read')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' }) @ApiParam({ name: 'productId', type: 'string', format: 'uuid' })
  @ApiOperation({ operationId: 'listProductClaims', summary: 'List brand-owned product claims and effective verification status', description: 'Lists product claim history. VERIFIED is returned only while every supporting evidence record is accepted, unexpired, unrecalled and backed by a clean asset with valid rights. Private asset URLs are never returned. Linear: REN2-68.' })
  @ApiExtension('x-renivet-permission', 'catalog.read') @ApiExtension('x-renivet-guard', 'brand')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOkResponse({ description: 'Claims for the authorized brand-owned product.', schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: CLAIM_DETAIL } } } })
  @ApiResponse({ status: 401, description: 'Authentication is required.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 403, description: 'Brand permission denied.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 404, description: 'Product is not accessible.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 409, description: 'Claim history cannot be returned in the current state.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 412, description: 'The supplied resource version does not match.', schema: CLAIM_ERROR })
  @ApiResponse({ status: 422, description: 'Claim query failed validation.', schema: CLAIM_ERROR })
  @ApiServiceUnavailableResponse({ description: 'Claim storage is unavailable.', schema: CLAIM_ERROR })
  async list(@Param('productId', new ParseUUIDPipe()) productId: string, @Req() request: ClaimRequest) {
    return this.claims.list(productId, this.readContext(request));
  }

  private async mutationContext(request: ClaimRequest, key: string | undefined): Promise<ClaimMutationContext> {
    if (!key || !/^[A-Za-z0-9._:-]{1,120}$/.test(key)) throw new UnprocessableEntityException({ code: 'CLAIM_REQUEST_INVALID', message: 'A valid idempotency key is required.' });
    const token = readSessionToken(request.headers.cookie);
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!token || !csrfMatches(request.headers, origins, this.sessions.expectedCsrf(token))) throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    const access = request.brandAccess!;
    return { userId: session.userId, brandId: access.brandId, permission: 'catalog.write',
      requestId: request.id ?? `claim:${key}`, idempotencyKey: key };
  }
  private readContext(request: ClaimRequest): ClaimReadContext {
    const access = request.brandAccess!;
    return { userId: access.userId, brandId: access.brandId, permission: 'catalog.read' };
  }
}
