import { Body, Controller, ForbiddenException, Headers, HttpCode, Param, Post, Req, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { MfaGuard, RequireMfa } from '../../common/guards/require-mfa';
import { PlatformPermissionGuard, RequirePlatformAdminPermission } from '../access/platform-permission.guard';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { CatalogReviewContext, CatalogReviewService } from './catalog-review';

interface RequestContext { id?: string; headers: Record<string, string | string[] | undefined>; platformPermission?: { userId: string }; }
const KEY = /^[A-Za-z0-9._:-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@ApiTags('Admin Review')
@ApiCookieAuth('renivetSession')
@Controller('admin/brands/:brandId/products/:productId/review')
@UseGuards(PlatformPermissionGuard, MfaGuard)
export class AdminQualityDecisionController {
  constructor(private readonly catalog: CatalogReviewService, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Post()
  @HttpCode(200)
  @RequirePlatformAdminPermission('catalog.review')
  @RequireMfa('catalog.review')
  @ApiExtension('x-renivet-permission', 'catalog.review')
  @ApiExtension('x-renivet-implementation-wave', 'W1')
  @ApiExtension('x-renivet-mfa-required', true)
  @ApiOperation({ operationId: 'decideAdminProductQcReview', summary: 'Record an independent decision for an exact submitted revision', description: 'Requires a global W1 catalog.review grant, recent MFA, session-bound CSRF and an idempotency key. The frozen revision and row version are compared by the transaction.' })
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['decision', 'reasonCode', 'expectedRevisionId', 'expectedRowVersion'], properties: {
    decision: { type: 'string', enum: ['APPROVED', 'REJECTED', 'CORRECTION_REQUIRED', 'RESTRICTED'] }, reasonCode: { type: 'string' },
    expectedRevisionId: { type: 'string', format: 'uuid' }, expectedRowVersion: { type: 'integer', minimum: 1 }, comment: { type: 'string', maxLength: 2000 },
  } } })
  async decide(@Param('brandId') brandId: string, @Param('productId') productId: string, @Body() body: unknown,
    @Req() request: RequestContext, @Headers('Idempotency-Key') key?: string): Promise<Record<string, unknown>> {
    if (!UUID.test(brandId) || !UUID.test(productId) || !key || !KEY.test(key)) {
      throw new UnprocessableEntityException({ code: 'CATALOG_REVIEW_REQUEST_INVALID', message: 'The review request is invalid.' });
    }
    const token = readSessionToken(request.headers.cookie);
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!token || !csrfMatches(request.headers, origins, this.sessions.expectedCsrf(token))) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    const context: CatalogReviewContext = { userId: session.userId, brandId, idempotencyKey: key };
    return this.catalog.decide(productId, body as Parameters<CatalogReviewService['decide']>[1], context);
  }
}

