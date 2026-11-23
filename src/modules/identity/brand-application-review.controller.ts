import { Body, Controller, ConflictException, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, ServiceUnavailableException, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { MfaGuard, RequireMfa } from '../../common/guards/require-mfa';
import { PlatformPermissionGuard, RequirePlatformAdminPermission } from '../access/platform-permission.guard';
import { csrfMatches, readSessionToken, SessionService } from './session.service';
import { BrandCatalogEligibilityService } from './brand-catalog-eligibility';
import { IdentityInfrastructure } from './identity-infrastructure';

interface ReviewRequest { headers: Record<string, string | string[] | undefined>; platformPermission?: { userId: string }; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;

@ApiTags('Admin Brand Review')
@ApiCookieAuth('renivetSession')
@Controller('admin/brands/:brandId/application-review')
@UseGuards(PlatformPermissionGuard, MfaGuard)
export class BrandApplicationReviewController {
  constructor(private readonly eligibility: BrandCatalogEligibilityService, private readonly sessions: SessionService, private readonly config: ConfigService, private readonly infrastructure: IdentityInfrastructure) {}

  @Get('attestations')
  @RequirePlatformAdminPermission('brand_membership.review')
  @RequireMfa('brand_membership.review')
  async attestations(@Param('brandId') brandId: string): Promise<{items:Array<{checkerUserId:string;decision:string}>}> {
    if (!UUID.test(brandId)) throw new UnprocessableEntityException({code:'BRAND_APPROVAL_REQUEST_INVALID'});
    const pool=this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({code:'BRAND_APPROVAL_UNAVAILABLE'});
    const found=await pool.query<{checkerUserId:string;decision:string}>(
      `SELECT checker_user_id AS "checkerUserId",decision
       FROM brands.brand_application_checker_attestations
       WHERE brand_id=$1 AND checked_at>clock_timestamp()-interval '7 days'
       ORDER BY checked_at DESC`,[brandId]);
    return {items:found.rows};
  }

  @Post('attest')
  @HttpCode(200)
  @RequirePlatformAdminPermission('brand_membership.review')
  @RequireMfa('brand_membership.review')
  async attest(@Param('brandId') brandId:string, @Body() body:unknown, @Req() req:ReviewRequest,
    @Headers('Idempotency-Key') requestId?:string):Promise<{status:'attested';checkerUserId:string;decision:'approved'|'rejected'}> {
    const value=body as Record<string,unknown>;
    const actor=req.platformPermission?.userId;
    const applicantUserId=String(value?.applicantUserId ?? '');
    const decision=String(value?.decision ?? '');
    if (!UUID.test(brandId) || !UUID.test(applicantUserId)
      || !['approved','rejected'].includes(decision) || !actor || !UUID.test(actor)
      || !requestId || !KEY.test(requestId))
      throw new UnprocessableEntityException({code:'BRAND_APPROVAL_REQUEST_INVALID'});
    const token=readSessionToken(req.headers.cookie);
    const session=await this.sessions.authenticate(token);
    const origins=this.config.get<string[]>('AUTH_ALLOWED_ORIGINS')??[];
    if (!token || !csrfMatches(req.headers,origins,this.sessions.expectedCsrf(token)) || session.userId!==actor)
      throw new ForbiddenException({code:'CSRF_REJECTED',message:'The operation could not be authorized.'});
    if (actor===applicantUserId) throw new ConflictException({code:'BRAND_APPROVAL_MAKER_CHECKER_REQUIRED'});
    const pool=this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({code:'BRAND_APPROVAL_UNAVAILABLE'});
    const inserted=await pool.query(
      `INSERT INTO brands.brand_application_checker_attestations
         (brand_id,applicant_user_id,checker_user_id,decision,request_id)
       SELECT b.id,m.user_id,$3,$4,$5
         FROM brands.brands b JOIN brands.brand_memberships m ON m.brand_id=b.id
        WHERE b.id=$1 AND b.onboarding_state='pending'
          AND m.user_id=$2 AND m.membership_state='pending'
       ON CONFLICT (brand_id,checker_user_id) DO NOTHING RETURNING decision`,
      [brandId,applicantUserId,actor,decision,requestId]);
    if (!inserted.rowCount) {
      const existing=await pool.query(
        `SELECT decision FROM brands.brand_application_checker_attestations
          WHERE brand_id=$1 AND checker_user_id=$2 AND applicant_user_id=$3`,
        [brandId,actor,applicantUserId]);
      if (existing.rows[0]?.decision!==decision)
        throw new ConflictException({code:'BRAND_APPROVAL_ATTESTATION_CONFLICT'});
    }
    return {status:'attested',checkerUserId:actor,decision:decision as 'approved'|'rejected'};
  }

  @Post()
  @HttpCode(200)
  @RequirePlatformAdminPermission('brand_membership.review')
  @RequireMfa('brand_membership.review')
  @ApiExtension('x-renivet-permission', 'brand_membership.review')
  @ApiExtension('x-renivet-implementation-wave', 'W1')
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
