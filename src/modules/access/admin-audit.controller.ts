import { Controller, Get, Query, ServiceUnavailableException, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiExtension, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlatformPermissionGuard, RequirePlatformAdminPermission } from './platform-permission.guard';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';

const permitted = (value: string) => /^[a-z][a-z0-9_.:-]{0,127}$/.test(value);
@ApiTags('Admin Audit')
@ApiCookieAuth('renivetSession')
@Controller('admin/security-audit')
@UseGuards(PlatformPermissionGuard)
@RequirePlatformAdminPermission('access_audit.read')
export class AdminAuditController {
  constructor(private readonly infra: IdentityInfrastructure) {}

  @Get()
  @ApiOperation({operationId:'listAuthorizedSecurityAudit',summary:'Read paginated immutable security audit metadata (not hashes or secrets)'})
  @ApiExtension('x-renivet-implementation-wave','W1')
  @ApiExtension('x-renivet-permission','access_audit.read')
  async list(@Query('limit') limit='25',@Query('cursor') cursor?:string,@Query('action') action?:string) {
    const count=Number(limit);
    if(!Number.isInteger(count)||count<1||count>100) throw new UnprocessableEntityException({code:'AUDIT_PAGE_SIZE_INVALID',message:'Page size must be between 1 and 100.'});
    if(cursor && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(cursor))throw new UnprocessableEntityException({code:'AUDIT_CURSOR_INVALID',message:'Invalid event cursor.'});
    if(action && !permitted(action))throw new UnprocessableEntityException({code:'AUDIT_FILTER_INVALID',message:'Invalid action filter.'});
    if(!this.infra.pool)throw new ServiceUnavailableException({code:'AUDIT_STORE_UNAVAILABLE',message:'Audit records are temporarily unavailable.'});
    const rows=await this.infra.pool.query(
      "SELECT e.id,e.action,e.subject_type AS \"subjectType\",e.subject_id AS \"subjectId\",e.request_id AS \"requestId\",e.occurred_at AS \"occurredAt\",COALESCE(u.display_name,u.email,'System') AS actor FROM access.security_audit_events e LEFT JOIN identity.users u ON u.id=e.actor_user_id WHERE ($1::text IS NULL OR e.action=$1) AND ($2::uuid IS NULL OR (e.occurred_at,e.id)<(SELECT occurred_at,id FROM access.security_audit_events WHERE id=$2)) ORDER BY e.occurred_at DESC,e.id DESC LIMIT $3",
      [action||null,cursor||null,count+1],
    );
    const items=rows.rows.slice(0,count);
    return {items,nextCursor:rows.rows.length>count?items[items.length-1]?.id:null};
  }
}
