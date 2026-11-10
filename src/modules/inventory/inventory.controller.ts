import { Body, Controller, ForbiddenException, Get, Headers, Param, Post, Query, Req, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiExtension, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { InventoryPostgresRepository } from './inventory.repository';

interface InventoryRequest extends BrandAccessRequest { id?: string; }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9._:-]{1,120}$/;
const requestError = (code: string) => new UnprocessableEntityException({ code, message: 'The inventory request is invalid.' });
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw requestError('INVENTORY_REQUEST_INVALID');
  return value as Record<string, unknown>;
};
const requiredString = (value: unknown, pattern?: RegExp) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || (pattern && !pattern.test(value))) throw requestError('INVENTORY_REQUEST_INVALID');
  return value.trim();
};
const requiredInteger = (value: unknown, min = 0) => {
  if (!Number.isSafeInteger(value) || Number(value) < min) throw requestError('INVENTORY_REQUEST_INVALID');
  return Number(value);
};

@ApiTags('Inventory')
@ApiCookieAuth('renivetSession')
@Controller('brands/:brandId/inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryPostgresRepository, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Get('balances')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.read')
  @ApiOperation({ operationId: 'listAuthoritativeBalances', summary: 'List brand-scoped stock balances and ATS' })
  @ApiParam({ name: 'brandId', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Authoritative balances derived from the PostgreSQL stock ledger.' })
  async balances(@Req() req: InventoryRequest, @Query('variantId') variantId?: string, @Query('locationId') locationId?: string) {
    this.validateFilters(variantId, locationId);
    return { items: await this.inventory.listBalances(req.brandAccess!, { variantId, locationId }) };
  }

  @Post('locations')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.location.manage')
  @ApiOperation({ operationId: 'createStockLocation' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiExtension('x-renivet-csrf-policy', 'W1 session-bound x-csrf-token and AUTH_ALLOWED_ORIGINS validation required.')
  async createLocation(@Req() req: InventoryRequest, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    await this.mutationContext(req, key);
    const input = record(body);
    return this.inventory.createLocation(req.brandAccess!, { code: requiredString(input.code, /^[A-Za-z0-9._:-]{1,64}$/), name: requiredString(input.name) }, key!);
  }

  @Post('balances')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.submit')
  @ApiOperation({ operationId: 'createStockPool' })
  async createPool(@Req() req: InventoryRequest, @Body() body: unknown) {
    await this.mutationContext(req, undefined, false);
    const b = record(body);
    return this.inventory.ensurePool(req.brandAccess!, requiredString(b.variantId, uuid), requiredString(b.locationId, uuid));
  }

  @Post('opening-receipts')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.submit')
  @ApiOperation({ operationId: 'recordOpeningStockReceipt' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async openingReceipt(@Req() req: InventoryRequest, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    await this.mutationContext(req, key);
    const b = record(body);
    if (b.unit !== 'EACH') throw requestError('STOCK_OPENING_RECEIPT_INVALID');
    return this.inventory.openingReceipt(req.brandAccess!, {
      variantId: requiredString(b.variantId, uuid), locationId: requiredString(b.locationId, uuid),
      quantity: requiredInteger(b.quantity, 1), unit: 'EACH', sourceType: requiredString(b.sourceType, /^[A-Z][A-Z0-9_]{0,31}$/),
      sourceReference: requiredString(b.sourceReference),
    }, key!);
  }

  @Post('observations')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.submit')
  @ApiOperation({ operationId: 'submitStockObservation' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async observe(@Req() req: InventoryRequest, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    await this.mutationContext(req, key);
    const b = record(body);
    return this.inventory.submitObservation(req.brandAccess!, {
      variantId: requiredString(b.variantId, uuid), locationId: requiredString(b.locationId, uuid),
      sourceNamespace: requiredString(b.sourceNamespace, /^[a-z][a-z0-9._-]{0,63}$/), sourceReference: requiredString(b.sourceReference),
      sourceVersion: b.sourceVersion === undefined ? undefined : requiredString(b.sourceVersion), asOf: requiredString(b.asOf),
      meaning: requiredString(b.meaning), quantity: requiredInteger(b.quantity), rawPayload: b.rawPayload,
    }, key!);
  }

  @Get('observations')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.read')
  @ApiOperation({ operationId: 'listStockObservationSignals' })
  async observations(@Req() req: InventoryRequest, @Query('limit') limit?: string) {
    const pageSize = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw requestError('INVENTORY_PAGE_SIZE_INVALID');
    return { items: await this.inventory.listObservations(req.brandAccess!, pageSize) };
  }

  @Post('observations/:observationId/propose-adjustment')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.adjust.propose')
  @ApiOperation({ operationId: 'proposeAdjustmentFromStockObservation' })
  @ApiParam({ name: 'observationId', format: 'uuid' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async proposeObservationAdjustment(@Req() req: InventoryRequest, @Param('observationId') observationId: string,
    @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    await this.mutationContext(req, key);
    if (!uuid.test(observationId)) throw requestError('INVENTORY_REQUEST_INVALID');
    const b = record(body);
    return this.inventory.proposeAdjustmentFromObservation(req.brandAccess!, observationId, requiredString(b.reason), key!);
  }

  @Post('adjustments')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.adjust.propose')
  @ApiOperation({ operationId: 'proposeStockAdjustment' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'If-Match', required: true })
  async propose(@Req() req: InventoryRequest, @Body() body: unknown, @Headers('idempotency-key') key?: string, @Headers('if-match') ifMatch?: string) {
    await this.mutationContext(req, key);
    const b = record(body); const expectedVersion = this.version(ifMatch);
    return this.inventory.proposeAdjustment(req.brandAccess!, { variantId: requiredString(b.variantId, uuid), locationId: requiredString(b.locationId, uuid),
      expectedVersion, delta: requiredInteger(Math.abs(Number(b.delta)), 1) * Math.sign(Number(b.delta)), reason: requiredString(b.reason),
      evidenceRef: b.evidenceRef === undefined || b.evidenceRef === null ? null : requiredString(b.evidenceRef), effectKey: key!,
      reconciliationCaseId: b.reconciliationCaseId === undefined ? undefined : requiredString(b.reconciliationCaseId, uuid) });
  }

  @Get('adjustments')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.read')
  @ApiOperation({ operationId: 'listStockAdjustmentHistory' })
  async adjustments(@Req() req: InventoryRequest, @Query('limit') limit?: string) {
    const pageSize = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw requestError('INVENTORY_PAGE_SIZE_INVALID');
    return { items: await this.inventory.listAdjustments(req.brandAccess!, pageSize) };
  }

  @Post('movements')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.submit')
  @ApiOperation({ operationId: 'recordPhysicalStockMovement' })
  @ApiExtension('x-renivet-contract-status', 'PROPOSED CONTRACT AMENDMENT FOR REN2-85; requires Engineering OS v1.5 contract update before activation.')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async receive(@Req() req: InventoryRequest, @Body() body: unknown, @Headers('idempotency-key') key?: string, @Headers('if-match') ifMatch?: string) {
    await this.mutationContext(req, key);
    const b = record(body);
    if (b.movementType !== 'RECEIPT') throw requestError('INVENTORY_MOVEMENT_TYPE_INVALID');
    return this.inventory.movement(req.brandAccess!, { variantId: requiredString(b.variantId, uuid), locationId: requiredString(b.locationId, uuid),
      expectedVersion: ifMatch ? this.version(ifMatch) : undefined, effectKey: key!, reason: requiredString(b.reason), sourceType: 'MANUAL',
      sourceReference: requiredString(b.sourceReference), deltaPhysical: requiredInteger(b.quantity, 1) });
  }

  @Get('movements')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.read')
  @ApiOperation({ operationId: 'listStockMovements' })
  async movements(@Req() req: InventoryRequest, @Query('variantId') variantId?: string, @Query('locationId') locationId?: string, @Query('limit') limit?: string) {
    this.validateFilters(variantId, locationId);
    const pageSize = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw requestError('INVENTORY_PAGE_SIZE_INVALID');
    return { items: await this.inventory.listMovements(req.brandAccess!, { variantId, locationId, limit: pageSize }) };
  }

  @Post('cycle-counts')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.count')
  @ApiOperation({ operationId: 'createCycleCount' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async cycleCount(@Req() req: InventoryRequest, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    await this.mutationContext(req, key); const b = record(body);
    return this.inventory.createCycleCount(req.brandAccess!, { variantId: requiredString(b.variantId, uuid), locationId: requiredString(b.locationId, uuid),
      physical: requiredInteger(b.physical), expectedVersion: requiredInteger(b.expectedVersion, 1) }, key!);
  }

  @Get('reconciliations')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.read')
  @ApiOperation({ operationId: 'listInventoryReconciliations' })
  async reconciliations(@Req() req: InventoryRequest) { return { items: await this.inventory.listReconciliationCases(req.brandAccess!) }; }

  @Post('reconciliations/:caseId/resolve')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.reconcile')
  @ApiOperation({ operationId: 'resolveReconciliation' })
  @ApiParam({ name: 'caseId', format: 'uuid' })
  async resolve(@Req() req: InventoryRequest, @Param('caseId') caseId: string, @Body() body: unknown,
    @Headers('idempotency-key') key?: string, @Headers('if-match') ifMatch?: string) {
    await this.mutationContext(req, key); if (!uuid.test(caseId)) throw requestError('INVENTORY_REQUEST_INVALID');
    const b = record(body); const expectedVersion = this.version(ifMatch);
    if (b.expectedCaseVersion !== expectedVersion) throw requestError('INVENTORY_VERSION_MISMATCH');
    if (b.decision !== 'DISMISS' && b.decision !== 'COMPENSATE') throw requestError('INVENTORY_RECONCILIATION_DECISION_INVALID');
    return this.inventory.resolveCase(req.brandAccess!, caseId, { decision: b.decision, expectedVersion,
      reason: requiredString(b.reasonCode), adjustmentId: b.approvedAdjustmentId === undefined ? undefined : requiredString(b.approvedAdjustmentId, uuid) }, key!);
  }

  @Post('transfers')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.submit')
  @ApiOperation({ operationId: 'transferStockBetweenLocations' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'If-Match', required: true })
  async transfer(@Req() req: InventoryRequest, @Body() body: unknown, @Headers('idempotency-key') key?: string, @Headers('if-match') ifMatch?: string) {
    await this.mutationContext(req, key); const b = record(body);
    return this.inventory.transfer(req.brandAccess!, { variantId: requiredString(b.variantId, uuid),
      fromLocationId: requiredString(b.fromLocationId, uuid), toLocationId: requiredString(b.toLocationId, uuid),
      quantity: requiredInteger(b.quantity, 1), reason: requiredString(b.reason), expectedFromVersion: this.version(ifMatch) }, key!);
  }

  @Post('transfers/:transferId/receive')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.submit')
  @ApiOperation({ operationId: 'receiveStockTransfer' })
  @ApiParam({ name: 'transferId', format: 'uuid' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'If-Match', required: true })
  async receiveTransfer(@Req() req: InventoryRequest, @Param('transferId') transferId: string,
    @Headers('idempotency-key') key?: string, @Headers('if-match') ifMatch?: string) {
    await this.mutationContext(req, key);
    if (!uuid.test(transferId)) throw requestError('INVENTORY_REQUEST_INVALID');
    return this.inventory.receiveTransfer(req.brandAccess!, transferId, this.version(ifMatch), key!);
  }

  @Post('returns')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('inventory.submit')
  @ApiOperation({ operationId: 'submitStockReturnForInspection' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async submitReturn(@Req() req: InventoryRequest, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    await this.mutationContext(req, key); const b = record(body);
    if (b.condition !== 'DAMAGED' && b.condition !== 'INSPECT' && b.condition !== 'SELLABLE_CLAIMED') throw requestError('STOCK_RETURN_CONDITION_INVALID');
    return this.inventory.createReturn(req.brandAccess!, { variantId: requiredString(b.variantId, uuid), locationId: requiredString(b.locationId, uuid),
      quantity: requiredInteger(b.quantity, 1), condition: b.condition, reason: requiredString(b.reason),
      evidenceReference: b.evidenceReference === undefined || b.evidenceReference === null ? null : requiredString(b.evidenceReference) }, key!);
  }

  private async mutationContext(req: InventoryRequest, key?: string, keyRequired = true) {
    if (keyRequired ? !key || !keyPattern.test(key) : key !== undefined && !keyPattern.test(key)) throw requestError('IDEMPOTENCY_KEY_INVALID');
    const token = readSessionToken(req.headers.cookie);
    if (!token) throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(req.headers, origins, this.sessions.expectedCsrf(token)) || session.userId !== req.brandAccess?.userId) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
  }

  private version(header?: string | string[]): number {
    const raw = Array.isArray(header) ? header[0] : header;
    const match = typeof raw === 'string' ? /^"?(\d+)"?$/.exec(raw) : null;
    if (!match || Number(match[1]) < 1 || !Number.isSafeInteger(Number(match[1]))) throw requestError('INVENTORY_VERSION_REQUIRED');
    return Number(match[1]);
  }

  private validateFilters(variantId?: string, locationId?: string) {
    if ((variantId !== undefined && !uuid.test(variantId)) || (locationId !== undefined && !uuid.test(locationId))) throw requestError('INVENTORY_FILTER_INVALID');
  }
}
