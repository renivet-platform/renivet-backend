import { Controller, Get, HttpException, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiExtension, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PlatformPermissionGuard, RequirePlatformAdminPermission } from './platform-permission.guard';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type AuditCursor = { occurredAt: string; id: string };
type AdminRequest = { platformPermission?: { userId: string; permission: string } };

function invalidCursor(): HttpException {
  return new HttpException({ code: 'AUDIT_PAGE_INVALID', message: 'The audit page request is invalid.' }, 400);
}
export function readAuditCursor(value: string | undefined): AuditCursor | null {
  if (value === undefined) return null;
  if (value.length > 350 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  let parsed: unknown;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded).toString('base64url') !== value) throw new Error('Noncanonical cursor');
    parsed = JSON.parse(decoded);
  } catch { throw invalidCursor(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidCursor();
  const candidate = parsed as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(',') !== 'id,occurredAt'
    || typeof candidate.id !== 'string' || !uuidPattern.test(candidate.id)
    || typeof candidate.occurredAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(candidate.occurredAt)
    || !Number.isFinite(Date.parse(candidate.occurredAt))
    || new Date(candidate.occurredAt).toISOString() !== candidate.occurredAt) throw invalidCursor();
  return { id: candidate.id, occurredAt: candidate.occurredAt };
}

export function nextAuditCursor(row: { id: string; occurredAt: string }): string {
  return Buffer.from(JSON.stringify({ occurredAt: row.occurredAt, id: row.id })).toString('base64url');
}

@ApiTags('Access audit')
@ApiCookieAuth('renivetSession')
@Controller('admin/access-audit')
export class AccessAuditController {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  @Get()
  @UseGuards(PlatformPermissionGuard)
  @RequirePlatformAdminPermission('access_audit.read')
  @ApiExtension('x-renivet-implementation-wave', 'W1')
  @ApiOperation({ operationId: 'listPlatformAccessAudit', summary: 'Read append-only security events with global administrator authorization' })
  @ApiQuery({ name: 'limit', required: false, type: 'integer', minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'cursor', required: false, type: 'string' })
  async list(@Req() request: AdminRequest, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const pageSize = limit === undefined ? 30 : Number(limit);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || (limit !== undefined && !/^\d{1,3}$/.test(limit))) throw invalidCursor();
    const after = readAuditCursor(cursor);
    const userId = request.platformPermission?.userId;
    if (!userId) throw new HttpException({ code:'PLATFORM_ACCESS_DENIED', message:'The operation could not be authorized.' },403);
    const pool = this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({ code:'AUDIT_SERVICE_UNAVAILABLE', message:'Audit records are temporarily unavailable.' });
    try {
      const response = await pool.query<{
        id: string; actorUserId: string | null; action: string; subjectType: string;
        subjectId: string | null; occurredAt: Date;
      }>(`SELECT events.id, events.actor_user_id AS "actorUserId",
             events.action, events.subject_type AS "subjectType",
             events.subject_id AS "subjectId", events.occurred_at AS "occurredAt"
         FROM access.security_audit_events events
         WHERE EXISTS (SELECT 1 FROM access.effective_permissions grants
             WHERE grants.user_id=$1 AND grants.permission_code='access_audit.read'
               AND grants.role_code='renivet_admin' AND grants.scope_type='global'
               AND grants.brand_id IS NULL)
           AND ($2::timestamptz IS NULL OR (events.occurred_at,events.id)<($2::timestamptz,$3::uuid))
         ORDER BY events.occurred_at DESC,events.id DESC LIMIT $4`,
        [userId, after?.occurredAt ?? null, after?.id ?? null, pageSize + 1]);
      const more = response.rows.length > pageSize;
      const items = response.rows.slice(0, pageSize).map(row => ({
        id:row.id, action:row.action, actorUserId:row.actorUserId,
        subjectType:row.subjectType, subjectId:row.subjectId, occurredAt:row.occurredAt.toISOString(),
      }));
      return { items, nextCursor: more && items.length ? nextAuditCursor(items[items.length-1]!) : null };
    } catch {
      throw new ServiceUnavailableException({ code:'AUDIT_SERVICE_UNAVAILABLE', message:'Audit records are temporarily unavailable.' });
    }
  }
}
