import { Injectable } from '@nestjs/common';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';

@Injectable()
export class BrandAccessRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async hasGlobalPermission(userId: string, permission: string): Promise<boolean> {
    const pool = this.infrastructure.pool;
    if (!pool) throw new Error('Authorization database is unavailable');
    const result = await pool.query(
      `SELECT 1
       FROM access.effective_permissions AS effective
       WHERE effective.user_id = $1
         AND effective.permission_code = $2
         AND effective.scope_type = 'global'
         AND effective.brand_id IS NULL
       LIMIT 1`,
      [userId, permission],
    );
    return result.rowCount === 1;
  }

  async hasPermission(userId: string, brandId: string, permission: string): Promise<boolean> {
    const pool = this.infrastructure.pool;
    if (!pool) throw new Error('Authorization database is unavailable');
    const result = await pool.query(
      `SELECT 1
       FROM access.effective_permissions AS effective
       WHERE effective.user_id = $1
         AND effective.permission_code = $3
         AND (
           (effective.scope_type = 'global' AND effective.brand_id IS NULL)
           OR (effective.scope_type = 'brand' AND effective.brand_id = $2)
         )
       LIMIT 1`,
      [userId, brandId, permission],
    );
    return result.rowCount === 1;
  }
}
