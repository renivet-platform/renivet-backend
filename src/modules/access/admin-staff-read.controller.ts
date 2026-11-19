import { Controller, Get, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { PlatformPermissionGuard, RequirePlatformAdminPermission } from './platform-permission.guard';

type RequestWithAdmin = { platformPermission?: {userId:string} };

/** Read-only staff directory sourced from actual W1 role assignments. Never grants access. */
@ApiExcludeController()
@Controller('admin/staff')
@UseGuards(PlatformPermissionGuard)
@RequirePlatformAdminPermission('access_audit.read')
export class AdminStaffReadController {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  @Get()
  async list(@Req() request: RequestWithAdmin): Promise<{items:Array<Record<string,unknown>>}> {
    const pool=this.infrastructure.pool;
    if(!pool)throw new ServiceUnavailableException({code:'ADMIN_STAFF_UNAVAILABLE'});
    const found=await pool.query(`
      SELECT u.id AS "userId",
             COALESCE(NULLIF(BTRIM(u.display_name),''),'Staff member') AS "name",
             u.email, r.role_code AS "role",
             a.active_from AS "activeFrom",a.active_until AS "activeUntil"
        FROM access.role_assignments a
        JOIN access.roles r ON r.id=a.role_id AND r.scope_kind='global'
        JOIN identity.users u ON u.id=a.user_id AND u.state='active'
       WHERE a.scope_type='global'
         AND a.active_from<=clock_timestamp()
         AND (a.active_until IS NULL OR a.active_until>clock_timestamp())
         AND EXISTS(SELECT 1 FROM access.effective_permissions p
                      WHERE p.user_id=$1 AND p.permission_code='access_audit.read'
                        AND p.role_code='renivet_admin' AND p.scope_type='global' AND p.brand_id IS NULL)
       ORDER BY lower(u.display_name),u.id,r.role_code LIMIT 100`,[request.platformPermission?.userId??null]);
    return {items:found.rows};
  }
}
