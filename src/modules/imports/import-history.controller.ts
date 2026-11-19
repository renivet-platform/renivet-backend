import { Controller, Get, Query, Req, ServiceUnavailableException, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';

@ApiTags('Catalogue imports')
@ApiCookieAuth('renivetSession')
@Controller('brands/:brandId/product-imports')
export class ImportHistoryController {
  constructor(private readonly infra: IdentityInfrastructure) {}

  @Get()
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('imports.write')
  @ApiOperation({ operationId:'listBrandCatalogImportBatches',summary:'List brand-scoped persisted import jobs in descending creation order' })
  async list(@Req() req: BrandAccessRequest, @Query('limit') limit='25', @Query('cursor') cursor?:string) {
    const n=Number(limit);
    if(!Number.isInteger(n)||n<1||n>100) throw new UnprocessableEntityException({code:'IMPORT_PAGE_SIZE_INVALID',message:'Use a page size between 1 and 100.'});
    if(cursor && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(cursor)) throw new UnprocessableEntityException({code:'IMPORT_CURSOR_INVALID',message:'Invalid import cursor.'});
    if(!this.infra.pool) throw new ServiceUnavailableException({code:'IMPORT_HISTORY_UNAVAILABLE',message:'Import history is temporarily unavailable.'});
    const rows=await this.infra.pool.query(
      "SELECT b.id,b.source_kind AS \"sourceKind\",b.job_state AS \"status\",b.created_at AS \"createdAt\",b.updated_at AS \"updatedAt\",b.source_as_of AS \"sourceAsOf\",u.file_name AS \"fileName\",COUNT(r.id)::int AS \"rowCount\" FROM imports.import_batches b LEFT JOIN imports.import_uploads u ON u.id=b.file_upload_id AND u.brand_id=b.brand_id LEFT JOIN imports.import_rows r ON r.batch_id=b.id AND r.brand_id=b.brand_id WHERE b.brand_id=$1 AND ($2::uuid IS NULL OR (b.created_at,b.id)<(SELECT created_at,id FROM imports.import_batches WHERE brand_id=$1 AND id=$2)) GROUP BY b.id,u.file_name ORDER BY b.created_at DESC,b.id DESC LIMIT $3",
      [req.brandAccess!.brandId,cursor??null,n+1],
    );
    const items=rows.rows.slice(0,n);
    return { items, nextCursor:rows.rows.length>n ? items[items.length-1]?.id : null };
  }
}
