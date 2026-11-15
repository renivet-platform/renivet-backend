import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiExtension, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlatformPermissionGuard, RequirePlatformAdminPermission } from '../access/platform-permission.guard';
import { BrandCatalogEligibilityService } from './brand-catalog-eligibility';

@ApiTags('Admin Brand Review')
@ApiCookieAuth('renivetSession')
@Controller('admin/brand-application-reviews')
@UseGuards(PlatformPermissionGuard)
@RequirePlatformAdminPermission('brand_membership.review')
export class BrandApplicationReviewListController {
  constructor(private readonly eligibility: BrandCatalogEligibilityService) {}

  @Get()
  @ApiOperation({ operationId: 'listPendingBrandApplicationReviews', summary: 'List persisted pending brand applications for review' })
  @ApiExtension('x-renivet-permission', 'brand_membership.review')
  @ApiExtension('x-renivet-implementation-wave', 'W1')
  async list(): Promise<{ items: Record<string, unknown>[] }> {
    return { items: await this.eligibility.listPending() };
  }
}
