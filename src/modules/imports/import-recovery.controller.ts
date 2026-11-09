import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Req, Res, UnprocessableEntityException, UseFilters, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { MfaGuard, RequireMfa } from '../../common/guards/require-mfa';
import { ConfigService } from '@nestjs/config';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { ImportRecoveryService } from './import-recovery.service';
import { ImportExceptionFilter } from './import-exception.filter';
import { RetryCatalogImportDto } from './import-recovery.dto';

interface RecoveryRequest extends BrandAccessRequest { id?: string }
const VALIDATION = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
  exceptionFactory: () => new UnprocessableEntityException({ code: 'IMPORT_RETRY_INVALID', message: 'The retry request is invalid.' }) });
const ERROR_SCHEMA = { type: 'object', required: ['code','message','requestId'], properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: { type: 'object', additionalProperties: true } } };
const RESULTS_SCHEMA = { type: 'object', required: ['batchId','items','retryRequests'], properties: { batchId: { type: 'string', format: 'uuid' },
  items: { type: 'array', items: { type: 'object', required: ['rowNumber','status','errorCodes','effectReceiptIds'], properties: {
    rowNumber: { type: 'integer' }, status: { type: 'string' }, errorCodes: { type: 'array', items: { type: 'string' } },
    effectReceiptIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
  } } }, nextCursor: { type: ['string','null'] }, retryRequests: { type: 'array', items: { type: 'object', required: ['retryRequestId','state','rowCount'], properties: {
    retryRequestId: { type: 'string', format: 'uuid' }, state: { type: 'string' }, rowCount: { type: 'integer', minimum: 0 }, errorCode: { type: ['string','null'] },
  } } } }, additionalProperties: false };
const ACTION_SCHEMA = { type: 'object', required: ['batchId','retryRequestId','state','rowCount'], properties: {
  batchId: { type: 'string', format: 'uuid' }, retryRequestId: { type: 'string', format: 'uuid' }, state: { type: 'string', enum: ['QUEUED','COMPLETED','PARTIAL','FAILED'] }, rowCount: { type: 'integer', minimum: 0 },
}, additionalProperties: false };

function getRequestId(value: string | undefined, fallback: string): string { return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : fallback; }
function matchRevision(value: string | undefined): number {
  const found = value?.match(/^(?:W\/)?"?(\d+)"?$/);
  const number = found ? Number(found[1]) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) throw new UnprocessableEntityException({ code: 'IMPORT_RETRY_PRECONDITION_REQUIRED', message: 'Send the current preview revision in If-Match.' });
  return number;
}

@ApiTags('Imports')
@ApiCookieAuth('sessionCookie')
@Controller('brands/:brandId/product-imports/:batchId')
@UseGuards(BrandAccessGuard)
@UseFilters(ImportExceptionFilter)
export class ImportRecoveryController {
  constructor(private readonly service: ImportRecoveryService, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Get('results')
  @RequireBrandPermission('imports.read')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'batchId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'imports.read')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOperation({ operationId: 'getImportResults', summary: 'Read sanitized, brand-scoped import outcomes' })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'format', required: false, schema: { type: 'string', enum: ['json','csv'], default: 'json' } })
  @ApiResponse({ status: 200, description: 'Redacted row results; use format=csv for a downloadable report.', content: {
    'application/json': { schema: RESULTS_SCHEMA }, 'text/csv': { schema: { type: 'string' } },
  } })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand access denied.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 404, description: 'The import batch is not available.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'The results cursor is invalid.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'The results page request is invalid.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 503, description: 'Import storage is unavailable.', schema: ERROR_SCHEMA })
  async results(@Param('batchId') batchId: string, @Req() request: RecoveryRequest,
    @Query('cursor') cursor?: string, @Query('limit') limit?: string, @Query('format') format?: string, @Res({ passthrough: true }) reply?: FastifyReply) {
    const pageLimit = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 100 || (format !== undefined && !['json','csv'].includes(format))) {
      throw new UnprocessableEntityException({ code: 'IMPORT_RESULTS_QUERY_INVALID', message: 'The results page request is invalid.' });
    }
    const access = request.brandAccess!;
    const result = await this.service.getResults({ brandId: access.brandId, batchId, actorUserId: access.userId,
      cursor: cursor ?? null, limit: pageLimit, format: format === 'csv' ? 'csv' : 'json' });
    if (format === 'csv') {
      reply?.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="import-${batchId}-results.csv"`);
      return result.csv;
    }
    return result.page;
  }

  @Post('retry')
  @HttpCode(202)
  @UseGuards(MfaGuard)
  @UsePipes(VALIDATION)
  @RequireBrandPermission('imports.write')
  @RequireMfa('imports.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'batchId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'imports.write')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-csrf-policy', 'W1 session-bound x-csrf-token, allowlisted Origin, same-origin fetch metadata, and MFA step-up required.')
  @ApiOperation({ operationId: 'retryImportFailures', summary: 'Queue a safe retry for failed import rows' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiHeader({ name: 'If-Match', required: true, description: 'The exact current immutable preview revision.' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['mode'], properties: {
    mode: { type: 'string', enum: ['FAILED_ONLY'] },
    errorCodes: { type: 'array', maxItems: 64, items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' } },
  } } })
  @ApiResponse({ status: 202, description: 'Retry command persisted to the W1 outbox.', schema: ACTION_SCHEMA })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand, permission, MFA, or CSRF denied.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 404, description: 'The import batch is not available.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Stale preview, idempotency conflict, or no eligible failed rows.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'The retry request or precondition is invalid.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 503, description: 'Import storage is unavailable.', schema: ERROR_SCHEMA })
  async retry(@Param('batchId') batchId: string, @Body() body: RetryCatalogImportDto, @Req() request: RecoveryRequest,
    @Headers('idempotency-key') key?: string, @Headers('if-match') ifMatch?: string) {
    if (!key || !/^[A-Za-z0-9._:-]{1,120}$/.test(key)) throw new UnprocessableEntityException({ code: 'IMPORT_IDEMPOTENCY_KEY_INVALID', message: 'A valid idempotency key is required.' });
    const previewRevision = matchRevision(ifMatch);
    const token = readSessionToken(request.headers.cookie);
    if (!token) throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(request.headers, origins, this.sessions.expectedCsrf(token))) throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    const access = request.brandAccess!;
    return this.service.retryFailures({ brandId: access.brandId, batchId, actorUserId: session.userId,
      requestId: getRequestId(request.id, `retry:${batchId}`), idempotencyKey: key, previewRevision,
      errorCodes: body.errorCodes ?? [] });
  }
}
