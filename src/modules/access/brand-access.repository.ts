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

  async hasGlobalAdminPermission(userId: string, permission: string): Promise<boolean> {
    const pool = this.infrastructure.pool;
    if (!pool) throw new Error('Authorization database is unavailable');
    const result = await pool.query(
      `SELECT 1 FROM access.effective_permissions AS effective
       WHERE effective.user_id = $1 AND effective.permission_code = $2
         AND effective.role_code = 'renivet_admin' AND effective.scope_type = 'global' AND effective.brand_id IS NULL
       LIMIT 1`, [userId, permission],
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

  async getMembershipSummary(userId: string, brandId: string) {
    const pool = this.infrastructure.pool;
    if (!pool) throw new Error('Authorization database is unavailable');
    const result = await pool.query(`
      SELECT b.id AS "brandId", b.display_name AS "brandName", b.onboarding_state AS "brandState",
             m.membership_state AS "membershipState", m.valid_from AS "validFrom", m.valid_until AS "validUntil",
             COALESCE(jsonb_agg(DISTINCT jsonb_build_object('roleCode', ep.role_code, 'permissionCode', ep.permission_code))
               FILTER (WHERE ep.permission_code IS NOT NULL), '[]'::jsonb) AS permissions
      FROM brands.brands b
      JOIN brands.brand_memberships m ON m.brand_id=b.id AND m.user_id=$1
      LEFT JOIN access.effective_permissions ep ON ep.user_id=$1 AND ep.brand_id=b.id
      WHERE b.id=$2
      GROUP BY b.id, b.display_name, b.onboarding_state, m.membership_state, m.valid_from, m.valid_until`, [userId, brandId]);
    return result.rows[0] ?? null;
  }

  async listTeamPermissions(userId: string, brandId: string) {
    const pool = this.infrastructure.pool;
    if (!pool) throw new Error('Authorization database is unavailable');
    const result = await pool.query(`
      SELECT m.user_id AS "userId",
             COALESCE(NULLIF(btrim(u.display_name), ''), 'Member') AS "memberName",
             m.membership_state AS "membershipState",
             COALESCE(jsonb_agg(DISTINCT jsonb_build_object('roleCode', ep.role_code, 'permissionCode', ep.permission_code))
               FILTER (WHERE ep.permission_code IS NOT NULL), '[]'::jsonb) AS permissions
      FROM brands.brand_memberships m
      JOIN identity.users u ON u.id=m.user_id
      LEFT JOIN access.effective_permissions ep ON ep.user_id=m.user_id AND ep.brand_id=m.brand_id
      WHERE m.brand_id=$1 AND m.membership_state <> 'revoked'
      GROUP BY m.user_id, u.display_name, m.membership_state
      ORDER BY memberName, m.user_id`, [brandId]);
    return result.rows;
  }
}
