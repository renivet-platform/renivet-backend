import { Body, Controller, ForbiddenException, Headers, HttpCode, Param, Post, Req, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { MfaGuard, RequireMfa } from '../../common/guards/require-mfa';
import { PlatformPermissionGuard, RequirePlatformAdminPermission } from '../access/platform-permission.guard';
import { csrfMatches, readSessionToken, SessionService } from './session.service';
import { BrandCatalogEligibilityService } from './brand-catalog-eligibility';

interface ReviewRequest { headers: Record<string, string | string[] | undefined>; platformPermission?: { userId: string }; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;

@ApiTags('Admin Brand Review')
@ApiCookieAuth('renivetSession')
@Controller('admin/brands/:brandId/application-review')
@UseGuards(PlatformPermissionGuard, MfaGuard)
export class BrandApplicationReviewController {
  constructor(private readonly eligibility: BrandCatalogEligibilityService, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Post()
  @HttpCode(200)
  @RequirePlatformAdminPermission('brand_membership.review')
  @RequireMfa('brand_membership.review')
  @ApiExtension('x-renivet-permission', 'brand_membership.review')
  @ApiExtension('x-renivet-mfa-required', true)
  @ApiOperation({ operationId: 'decideBrandApplicationReview', summary: 'Approve or reject a pending brand application', description: 'Admin-only W1 application decision. Requires independent checker, recent MFA, session-bound CSRF and an idempotent event id.' })
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['applicantUserId', 'checkedByUserId', 'decision', 'eventId'], properties: {
    applicantUserId: { type: 'string', format: 'uuid' }, checkedByUserId: { type: 'string', format: 'uuid' },
    decision: { type: 'string', enum: ['approved', 'rejected'] }, eventId: { type: 'string', format: 'uuid' },
  } } })
  async decide(@Param('brandId') brandId: string, @Body() body: unknown, @Req() request: ReviewRequest, @Headers('Idempotency-Key') requestId?: string): Promise<Record<string, unknown>> {
    const value = body as Record<string, unknown>;
    const actor = request.platformPermission?.userId;
    if (!UUID.test(brandId) || !actor || !UUID.test(String(value?.applicantUserId)) || !UUID.test(String(value?.checkedByUserId))
      || !UUID.test(String(value?.eventId)) || !['approved', 'rejected'].includes(String(value?.decision)) || !requestId || !KEY.test(requestId)) {
      throw new UnprocessableEntityException({ code: 'BRAND_APPROVAL_REQUEST_INVALID', message: 'The brand review request is invalid.' });
    }
    const token = readSessionToken(request.headers.cookie);
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!token || !csrfMatches(request.headers, origins, this.sessions.expectedCsrf(token))) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    return this.eligibility.applyOutcome({
      eventId: String(value.eventId), brandId, applicantUserId: String(value.applicantUserId), decision: String(value.decision) as 'approved' | 'rejected',
      approvedByUserId: session.userId, checkedByUserId: String(value.checkedByUserId), requestId,
    });
  }
}
