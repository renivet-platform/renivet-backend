import { Controller, Get, Param, Req, ServiceUnavailableException, UseGuards, UnprocessableEntityException } from '@nestjs/common';
import { ApiCookieAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { PlatformPermissionGuard, RequirePlatformAdminPermission } from '../access/platform-permission.guard';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@ApiTags('Catalogue imports')
@ApiCookieAuth('renivetSession')
@Controller('brands/:brandId/product-imports/:batchId/category-requests')
export class BrandImportCategoryRequestsController {
  constructor(private readonly infra: IdentityInfrastructure) {}

  @Get()
  @ApiExcludeEndpoint() // Pending contract / SDK synchronization.
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('imports.read')
  async list(@Param('batchId') batchId: string, @Req() req: BrandAccessRequest) {
    if (!uuid.test(batchId)) throw new UnprocessableEntityException({
      code: 'IMPORT_BATCH_INVALID', message: 'The import batch identifier is invalid.',
    });
    const pool = this.infra.pool;
    if (!pool) throw new ServiceUnavailableException({ code: 'IMPORT_DATABASE_UNAVAILABLE', message: 'Import storage is temporarily unavailable.' });
    const result = await pool.query(`SELECT source_category_code AS "sourceCode",source_category_name AS "name",
      request_state AS "status",source_row_number AS "firstSourceRow",created_at AS "createdAt"
      FROM imports.import_category_requests WHERE brand_id=$1 AND batch_id=$2
      ORDER BY created_at,id LIMIT 100`, [req.brandAccess!.brandId,batchId]);
    return { items: result.rows };
  }
}

@ApiTags('Catalog')
@ApiCookieAuth('renivetSession')
@Controller('admin/catalog/import-category-requests')
export class AdminImportCategoryRequestsController {
  constructor(private readonly infra: IdentityInfrastructure) {}

  @Get()
  @ApiExcludeEndpoint() // Pending contract / SDK synchronization.
  @UseGuards(PlatformPermissionGuard)
  @RequirePlatformAdminPermission('taxonomy.approve')
  async list() {
    const pool = this.infra.pool;
    if (!pool) throw new ServiceUnavailableException({ code: 'IMPORT_DATABASE_UNAVAILABLE', message: 'Import storage is temporarily unavailable.' });
    const result = await pool.query(`SELECT r.id,r.brand_id AS "brandId",r.batch_id AS "batchId",
      r.source_category_code AS "sourceCode",r.source_category_name AS "name",
      r.request_state AS "status",r.source_row_number AS "firstSourceRow",r.created_at AS "createdAt"
      FROM imports.import_category_requests r WHERE r.request_state='PENDING'
      ORDER BY r.created_at,r.id LIMIT 100`);
    return { items: result.rows };
  }
}
