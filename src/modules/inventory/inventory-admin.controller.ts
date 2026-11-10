import { Body, Controller, ForbiddenException, Headers, Param, Post, Req, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { MfaGuard } from '../../common/guards/require-mfa';
import { PlatformPermissionGuard, RequirePlatformPermission } from '../access/platform-permission.guard';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { InventoryPostgresRepository } from './inventory.repository';

interface AdminRequest {
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, unknown>;
  platformPermission?: { readonly userId: string; readonly permission: string };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code: string) => new UnprocessableEntityException({ code, message: 'The inventory request is invalid.' });
const bodyRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('INVENTORY_REQUEST_INVALID');
  return value as Record<string, unknown>;
};
const cleanString = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw fail('INVENTORY_REQUEST_INVALID');
  return value.trim();
};

@ApiTags('Inventory')
@ApiCookieAuth('renivetSession')
@Controller('admin/brands/:brandId/inventory')
export class InventoryAdminController {
  constructor(private readonly inventory: InventoryPostgresRepository, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Post('adjustments/:adjustmentId/decision')
  @UseGuards(PlatformPermissionGuard, MfaGuard)
  @RequirePlatformPermission('inventory.adjust.approve')
  @ApiOperation({ operationId: 'decideStockAdjustment' })
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiParam({ name: 'adjustmentId', format: 'uuid' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'If-Match', required: true })
  async decideAdjustment(@Req() req: AdminRequest, @Param('brandId') brandId: string, @Param('adjustmentId') adjustmentId: string,
    @Body() body: unknown, @Headers('if-match') ifMatch?: string, @Headers('idempotency-key') key?: string) {
    const context = await this.context(req, brandId, key);
    if (!UUID.test(adjustmentId)) throw fail('INVENTORY_REQUEST_INVALID');
    const b = bodyRecord(body);
    if (b.decision !== 'APPROVE' && b.decision !== 'REJECT') throw fail('INVENTORY_DECISION_INVALID');
    const version = this.version(ifMatch);
    return this.inventory.decideAdjustment({ ...context, permission: 'inventory.adjust.approve' }, {
      adjustmentId, expectedVersion: version, decision: b.decision, reason: cleanString(b.reason),
    }, key!);
  }

  @Post('returns/:returnId/decision')
  @UseGuards(PlatformPermissionGuard, MfaGuard)
  @RequirePlatformPermission('inventory.adjust.approve')
  @ApiOperation({ operationId: 'decideStockReturnInspection' })
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiParam({ name: 'returnId', format: 'uuid' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async decideReturn(@Req() req: AdminRequest, @Param('brandId') brandId: string, @Param('returnId') returnId: string,
    @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const context = await this.context(req, brandId, key);
    if (!UUID.test(returnId)) throw fail('INVENTORY_REQUEST_INVALID');
    const b = bodyRecord(body);
    if (b.decision !== 'ACCEPT' && b.decision !== 'REJECT') throw fail('STOCK_RETURN_DECISION_INVALID');
    return this.inventory.decideReturn({ ...context, permission: 'inventory.adjust.approve' }, {
      returnId, expectedDecision: b.decision, reason: cleanString(b.reason),
    }, key!);
  }

  private async context(req: AdminRequest, brandId: string, key?: string) {
    if (!UUID.test(brandId) || !key || !/^[A-Za-z0-9._:-]{1,120}$/.test(key)) throw fail('INVENTORY_REQUEST_INVALID');
    const token = readSessionToken(req.headers.cookie);
    if (!token) throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(req.headers, origins, this.sessions.expectedCsrf(token)) || session.userId !== req.platformPermission?.userId) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    return { userId: session.userId, brandId };
  }

  private version(header?: string | string[]) {
    const raw = Array.isArray(header) ? header[0] : header;
    const match = typeof raw === 'string' ? /^"?(\d+)"?$/.exec(raw) : null;
    if (!match || Number(match[1]) < 1 || !Number.isSafeInteger(Number(match[1]))) throw fail('INVENTORY_VERSION_REQUIRED');
    return Number(match[1]);
  }
}
