import { Body, Controller, ForbiddenException, Headers, HttpCode, Param, Post, Req, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { MfaGuard, RequireMfa } from '../../common/guards/require-mfa';
import { PlatformPermissionGuard, RequirePlatformAdminPermission } from '../access/platform-permission.guard';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { CatalogPublicationService, ReasonedPublicationInput } from './catalog-publication';

interface RequestContext { id?: string; headers: Record<string, string | string[] | undefined>; }
const KEY = /^[A-Za-z0-9._:-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASONED_SCHEMA = { type: 'object', additionalProperties: false, required: ['reasonCode', 'expectedProductVersion'], properties: {
  reasonCode: { type: 'string' }, expectedProductVersion: { type: 'integer', minimum: 1 }, comment: { type: 'string', maxLength: 2000 }, appealReference: { type: 'string', maxLength: 256 },
} };

@ApiTags('Admin Review')
@ApiCookieAuth('renivetSession')
@Controller('admin/brands/:brandId/products/:productId/publication')
@UseGuards(PlatformPermissionGuard, MfaGuard)
export class AdminPublicationDecisionController {
  constructor(private readonly publication: CatalogPublicationService, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Post('publish') @HttpCode(200) @RequirePlatformAdminPermission('catalog.publish') @RequireMfa('catalog.publish')
  @ApiExtension('x-renivet-permission', 'catalog.publish') @ApiExtension('x-renivet-implementation-wave', 'W1') @ApiExtension('x-renivet-mfa-required', true)
  @ApiOperation({ operationId: 'publishAdminCatalogRevision', summary: 'Publish the exact QC-approved revision', description: 'Requires global catalog.publish permission, recent MFA, session-bound CSRF and an idempotency key. The request names both the approved revision and QC approval receipt.' })
  @ApiParam({ name: 'brandId', format: 'uuid' }) @ApiParam({ name: 'productId', format: 'uuid' }) @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['approvedRevisionId', 'approvedReviewId', 'expectedProductVersion'], properties: {
    approvedRevisionId: { type: 'string', format: 'uuid' }, approvedReviewId: { type: 'string', format: 'uuid' }, expectedProductVersion: { type: 'integer', minimum: 1 },
  } } })
  async publish(@Param('brandId') brandId: string, @Param('productId') productId: string, @Body() body: { approvedRevisionId: string; approvedReviewId: string; expectedProductVersion: number },
    @Req() request: RequestContext, @Headers('Idempotency-Key') key?: string) {
    const context = await this.context(brandId, request, key, body.expectedProductVersion);
    return this.publication.publish(productId, body, context);
  }

  @Post('restrict') @HttpCode(200) @RequirePlatformAdminPermission('catalog.restrict') @RequireMfa('catalog.restrict')
  @ApiExtension('x-renivet-permission', 'catalog.restrict') @ApiExtension('x-renivet-implementation-wave', 'W1') @ApiExtension('x-renivet-mfa-required', true)
  @ApiOperation({ operationId: 'restrictAdminCatalogProduct', summary: 'Restrict a published catalog listing with an audit reason' })
  @ApiParam({ name: 'brandId', format: 'uuid' }) @ApiParam({ name: 'productId', format: 'uuid' }) @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiBody({ schema: REASONED_SCHEMA })
  async restrict(@Param('brandId') brandId: string, @Param('productId') productId: string, @Body() body: ReasonedPublicationInput & { expectedProductVersion: number },
    @Req() request: RequestContext, @Headers('Idempotency-Key') key?: string) {
    const context = await this.context(brandId, request, key, body.expectedProductVersion);
    return this.publication.restrict(productId, body, context);
  }

  @Post('unpublish') @HttpCode(200) @RequirePlatformAdminPermission('catalog.restrict') @RequireMfa('catalog.restrict')
  @ApiExtension('x-renivet-permission', 'catalog.restrict') @ApiExtension('x-renivet-implementation-wave', 'W1') @ApiExtension('x-renivet-mfa-required', true)
  @ApiOperation({ operationId: 'unpublishAdminCatalogProduct', summary: 'Unpublish a listing while retaining its approved revision and audit history' })
  @ApiParam({ name: 'brandId', format: 'uuid' }) @ApiParam({ name: 'productId', format: 'uuid' }) @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiBody({ schema: REASONED_SCHEMA })
  async unpublish(@Param('brandId') brandId: string, @Param('productId') productId: string, @Body() body: ReasonedPublicationInput & { expectedProductVersion: number },
    @Req() request: RequestContext, @Headers('Idempotency-Key') key?: string) {
    const context = await this.context(brandId, request, key, body.expectedProductVersion);
    return this.publication.unpublish(productId, body, context);
  }

  private async context(brandId: string, request: RequestContext, key: string | undefined, expectedProductVersion: number) {
    if (!UUID.test(brandId) || !key || !KEY.test(key) || !Number.isSafeInteger(expectedProductVersion) || expectedProductVersion < 1) {
      throw new UnprocessableEntityException({ code: 'CATALOG_PUBLICATION_REQUEST_INVALID', message: 'The publication request is invalid.' });
    }
    const token = readSessionToken(request.headers.cookie);
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!token || !csrfMatches(request.headers, origins, this.sessions.expectedCsrf(token))) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    return { userId: session.userId, brandId, expectedProductVersion, idempotencyKey: key };
  }
}

