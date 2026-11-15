import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiExtension, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from './brand-access.guard';
import { BrandAccessRepository } from './brand-access.repository';

@ApiTags('Brand access')
@ApiCookieAuth('renivetSession')
@Controller('brands/:brandId/access')
export class BrandMembershipController {
  constructor(private readonly access: BrandAccessRepository) {}

  @Get()
  @UseGuards(BrandAccessGuard)
  // Brand owners already receive the reviewed `brand_membership.read` grant;
  // use that permission for the summary so owners can enter their workspace.
  @RequireBrandPermission('brand_membership.read')
  @ApiOperation({ operationId: 'getBrandMembershipSummary', summary: 'Read the authenticated member’s brand access summary' })
  @ApiExtension('x-renivet-implementation-wave', 'W1')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  async summary(@Req() req: BrandAccessRequest) {
    const summary = await this.access.getMembershipSummary(req.brandAccess!.userId, req.brandAccess!.brandId);
    return summary ? { ...summary, permissions: summary.permissions ?? [] } : { membershipState: 'unavailable', permissions: [] };
  }

  @Get('team')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('brand_membership.read')
  @ApiOperation({ operationId: 'listBrandTeamPermissions', summary: 'Read redacted brand team membership and permissions' })
  @ApiExtension('x-renivet-implementation-wave', 'W1')
  @ApiParam({ name: 'brandId', format: 'uuid' })
  async team(@Req() req: BrandAccessRequest) {
    return { items: await this.access.listTeamPermissions(req.brandAccess!.userId, req.brandAccess!.brandId) };
  }
}
