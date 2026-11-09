import { Body, Controller, ForbiddenException, Headers, HttpCode, Param, Post, Req, UnprocessableEntityException, UseFilters, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiNotFoundResponse, ApiOperation, ApiParam, ApiResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { MfaGuard, RequireMfa } from '../../common/guards/require-mfa';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { readSessionToken, SessionService, csrfMatches } from '../identity/session.service';
import { ImportExceptionFilter } from './import-exception.filter';
import { ConfirmCatalogImportDto } from './import-confirmation.dto';
import { ImportConfirmationService } from './import-confirmation.service';

interface ConfirmationRequest extends BrandAccessRequest { id?: string }
const VALIDATION = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
  exceptionFactory: () => new UnprocessableEntityException({ code: 'IMPORT_CONFIRM_INVALID', message: 'The confirmation request is invalid.' }) });
const ERROR_SCHEMA = { type: 'object', required: ['code', 'message', 'requestId'], properties: {
  code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: { type: 'object', additionalProperties: true },
} };
const RECEIPT_SCHEMA = { type: 'object', required: ['confirmationId','batchId','previewRevision','previewHash','state','appliedRows','failedRows','effectsApplied','noopRows'], properties: {
  confirmationId: { type: 'string', format: 'uuid' }, batchId: { type: 'string', format: 'uuid' }, previewRevision: { type: 'integer', minimum: 1 },
  previewHash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, state: { type: 'string', enum: ['COMPLETED','PARTIAL'] },
  appliedRows: { type: 'integer', minimum: 0 }, failedRows: { type: 'integer', minimum: 0 }, effectsApplied: { type: 'integer', minimum: 0 },
  noopRows: { type: 'integer', minimum: 0 },
  applied: { type: 'array', items: { type: 'object', additionalProperties: true } }, failed: { type: 'array', items: { type: 'object', additionalProperties: true } },
}, additionalProperties: false };

function requestId(value: string | undefined, fallback: string): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : fallback;
}
function revisionHeader(value: string | undefined): number {
  const match = value?.match(/^(?:W\/)?"?(\d+)"?$/);
  if (!match) throw new UnprocessableEntityException({ code: 'IMPORT_CONFIRM_PRECONDITION_REQUIRED', message: 'Send the preview revision in If-Match before confirming.' });
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new UnprocessableEntityException({ code: 'IMPORT_CONFIRM_PRECONDITION_REQUIRED', message: 'Send the current preview revision in If-Match.' });
  return revision;
}

@ApiTags('Imports')
@ApiCookieAuth('sessionCookie')
@Controller('brands/:brandId/product-imports/:batchId')
@UseGuards(BrandAccessGuard)
@UseFilters(ImportExceptionFilter)
export class ImportConfirmationController {
  constructor(private readonly service: ImportConfirmationService, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Post('confirm')
  @HttpCode(202)
  @UseGuards(MfaGuard)
  @UsePipes(VALIDATION)
  @RequireBrandPermission('imports.confirm')
  @RequireMfa('imports.confirm')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'batchId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'imports.confirm')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOperation({ operationId: 'confirmCatalogImport', summary: 'Confirm a frozen import preview and apply draft-only effects atomically' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiHeader({ name: 'If-Match', required: true, description: 'The immutable preview revision being confirmed.' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['previewHash','previewRevision','allowPartial'], properties: {
    previewHash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, previewRevision: { type: 'integer', minimum: 1 }, allowPartial: { type: 'boolean' },
  } } })
  @ApiExtension('x-renivet-csrf-policy', 'W1 session validates x-csrf-token and allowlisted Origin; CSRF state is session-bound.')
  @ApiResponse({ status: 202, description: 'The confirmation result and per-target effect receipt counts.', schema: RECEIPT_SCHEMA })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission, MFA, or CSRF denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'The import batch is not available.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Preview stale or idempotency conflict.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'Confirmation data or row effects are invalid.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 503, description: 'Import storage is unavailable.', schema: ERROR_SCHEMA })
  async confirm(@Param('batchId') batchId: string, @Body() body: ConfirmCatalogImportDto, @Req() request: ConfirmationRequest,
    @Headers('idempotency-key') key?: string, @Headers('if-match') ifMatch?: string) {
    if (!key || !/^[A-Za-z0-9._:-]{1,120}$/.test(key)) throw new UnprocessableEntityException({ code: 'IMPORT_IDEMPOTENCY_KEY_INVALID', message: 'A valid idempotency key is required.' });
    if (revisionHeader(ifMatch) !== body.previewRevision) throw new UnprocessableEntityException({ code: 'IMPORT_CONFIRM_PRECONDITION_MISMATCH', message: 'If-Match must identify the same preview revision as the request body.' });
    const token = readSessionToken(request.headers.cookie);
    if (!token) throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(request.headers, origins, this.sessions.expectedCsrf(token))) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    const access = request.brandAccess!;
    return this.service.confirm({ brandId: access.brandId, batchId, actorUserId: session.userId, idempotencyKey: key,
      previewRevision: body.previewRevision, previewHash: body.previewHash, allowPartial: body.allowPartial,
      requestId: requestId(request.id, `confirm:${batchId}`) });
  }
}
