import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiExcludeEndpoint, ApiExtension, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlatformPermissionGuard, RequirePlatformAdminPermission } from '../access/platform-permission.guard';
import { BrandCatalogEligibilityService } from './brand-catalog-eligibility';
import { IdentityInfrastructure } from './identity-infrastructure';
import { ServiceUnavailableException } from '@nestjs/common';

@ApiTags('Admin Brand Review')
@ApiCookieAuth('renivetSession')
@Controller('admin/brand-application-reviews')
@UseGuards(PlatformPermissionGuard)
@RequirePlatformAdminPermission('brand_membership.review')
export class BrandApplicationReviewListController {
  constructor(private readonly eligibility: BrandCatalogEligibilityService, private readonly infrastructure: IdentityInfrastructure) {}

  @Get('reviewers')
  @ApiExcludeEndpoint()
  async reviewers(): Promise<{items:Array<{id:string;name:string}>}> {
    const pool=this.infrastructure.pool;
    if(!pool)throw new ServiceUnavailableException({code:'BRAND_REVIEWERS_UNAVAILABLE'});
    const found=await pool.query<{id:string;name:string}>(`
      SELECT u.id,COALESCE(NULLIF(BTRIM(u.display_name),''),'Verified reviewer') AS name
        FROM identity.users u
       WHERE u.state='active' AND u.email_verified_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM access.effective_permissions ep
            WHERE ep.user_id=u.id AND ep.permission_code='brand_membership.review'
              AND ep.role_code='renivet_admin' AND ep.scope_type='global' AND ep.brand_id IS NULL
         )
       ORDER BY name,u.id LIMIT 100`);
    return {items:found.rows};
  }

  @Get()
  @ApiOperation({ operationId: 'listPendingBrandApplicationReviews', summary: 'List persisted pending brand applications for review' })
  @ApiExtension('x-renivet-permission', 'brand_membership.review')
  @ApiExtension('x-renivet-implementation-wave', 'W1')
  async list(): Promise<{ items: Record<string, unknown>[] }> {
    return { items: await this.eligibility.listPending() };
  }
}
