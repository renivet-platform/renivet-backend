import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiExtension,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePlatformAdminPermission } from '../access/platform-permission.guard';
import { PlatformPermissionGuard } from '../access/platform-permission.guard';
import { TaxonomyAdminService } from './taxonomy-admin.service';

@ApiTags('Catalog')
@Controller('admin/catalog/categories')
@ApiCookieAuth('renivetSession')
export class TaxonomyAdminReadController {
  constructor(private readonly taxonomy: TaxonomyAdminService) {}

  @Get()
  @UseGuards(PlatformPermissionGuard)
  @RequirePlatformAdminPermission('taxonomy.approve')
  @ApiOperation({ operationId: 'listAdminTaxonomyCategories', summary: 'List global taxonomy categories for administration' })
  @ApiExtension('x-renivet-permission', 'taxonomy.approve')
  async listCategories(): Promise<{ items: Record<string, unknown>[] }> {
    return { items: await this.taxonomy.listCategories() };
  }

  @Get('attributes')
  @UseGuards(PlatformPermissionGuard)
  @RequirePlatformAdminPermission('taxonomy.approve')
  @ApiOperation({ operationId: 'listAdminTaxonomyAttributes', summary: 'List taxonomy attributes for administration' })
  @ApiExtension('x-renivet-permission', 'taxonomy.approve')
  async listAttributes(): Promise<{ items: Record<string, unknown>[] }> {
    return { items: await this.taxonomy.listAttributes() };
  }
}
