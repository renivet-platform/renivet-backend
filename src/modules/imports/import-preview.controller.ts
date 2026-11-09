import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UnprocessableEntityException, UseFilters, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiNotFoundResponse, ApiOperation, ApiParam, ApiResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { MfaGuard, RequireMfa } from '../../common/guards/require-mfa';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { ImportExceptionFilter } from './import-exception.filter';
import { SaveImportMappingDto } from './import-mapping.dto';
import { ImportPreviewService } from './import-preview.service';

interface ImportPreviewRequest extends BrandAccessRequest { id?: string }
const VALIDATION = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
  exceptionFactory: () => new UnprocessableEntityException({ code: 'IMPORT_MAPPING_INVALID', message: 'The mapping request is invalid.' }) });
const ERROR_SCHEMA = { type: 'object', required: ['code', 'message', 'requestId'], properties: {
  code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: { type: 'object', additionalProperties: true },
} };
const TARGET_VERSION_SCHEMA = { type: 'object', required: ['productId','variantId','productRowVersion','variantRowVersion','contentVersion'], properties: {
  productId: { type: 'string', format: 'uuid' }, variantId: { type: ['string','null'], format: 'uuid' }, productRowVersion: { type: 'integer', minimum: 1 },
  variantRowVersion: { type: 'integer', minimum: 1 }, contentVersion: { type: 'integer', minimum: 1 },
}, additionalProperties: false };
const PREVIEW_SCHEMA = { type: 'object', required: ['batchId','brandId','previewRevision','sourceSha256','sourceAsOf','mappingVersion','taxonomyVersion','taxonomySnapshotSha256','fieldMasks','targetVersions','rows','counts','previewHash'], properties: {
  batchId: { type: 'string', format: 'uuid' }, brandId: { type: 'string', format: 'uuid' }, previewRevision: { type: 'integer', minimum: 1 },
  sourceSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, sourceAsOf: { type: 'string', format: 'date-time' }, mappingVersion: { type: 'integer', minimum: 1 },
  taxonomyVersion: { type: 'integer', minimum: 1 }, taxonomySnapshotSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  fieldMasks: { type: 'array', items: { type: 'string' } }, targetVersions: { type: 'array', items: { type: 'object', required: ['sourceRowNumber','productId','variantId','productRowVersion','variantRowVersion','contentVersion'], properties: {
    sourceRowNumber: { type: 'integer', minimum: 1 }, ...TARGET_VERSION_SCHEMA.properties,
  }, additionalProperties: false } },
  rows: { type: 'array', items: { type: 'object', required: ['sourceRowNumber','action','proposed','fieldMask','targetVersion','conflicts'], properties: {
    sourceRowNumber: { type: 'integer', minimum: 1 }, action: { type: 'string', enum: ['CREATE','UPDATE','NOOP','CONFLICT','NEEDS_REVIEW','INVALID'] },
    proposed: { type: 'object', additionalProperties: true }, fieldMask: { type: 'array', items: { type: 'string' } },
    targetVersion: { anyOf: [TARGET_VERSION_SCHEMA, { type: 'null' }] }, conflicts: { type: 'array', items: { type: 'object', required: ['code','message'], properties: { code: { type: 'string' }, message: { type: 'string' } }, additionalProperties: false } },
  }, additionalProperties: false } },
  counts: { type: 'object', required: ['create','update','noop','conflict','review','invalid'], properties: {
    create: { type: 'integer', minimum: 0 }, update: { type: 'integer', minimum: 0 }, noop: { type: 'integer', minimum: 0 },
    conflict: { type: 'integer', minimum: 0 }, review: { type: 'integer', minimum: 0 }, invalid: { type: 'integer', minimum: 0 },
  }, additionalProperties: false }, previewHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
}, additionalProperties: false };
const MAPPING_RECEIPT_SCHEMA = { type: 'object', required: ['mappingVersion','previewRevision','previewHash'], properties: {
  mappingVersion: { type: 'integer', minimum: 1 }, previewRevision: { type: 'integer', minimum: 1 }, previewHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
}, additionalProperties: false };

function requestId(value: string | undefined, fallback: string): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : fallback;
}

function expectedVersion(value: string | undefined): number {
  const match = value?.match(/^(?:W\/)?"?(\d+)"?$/);
  if (!match) throw new UnprocessableEntityException({ code: 'IMPORT_MAPPING_PRECONDITION_REQUIRED', message: 'Reload the import and send its current mapping version.' });
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 0) throw new UnprocessableEntityException({ code: 'IMPORT_MAPPING_PRECONDITION_REQUIRED', message: 'Reload the import and send its current mapping version.' });
  return version;
}

@ApiTags('Imports')
@ApiCookieAuth('sessionCookie')
@Controller('brands/:brandId/product-imports/:batchId')
@UseGuards(BrandAccessGuard)
@UseFilters(ImportExceptionFilter)
export class ImportPreviewController {
  constructor(private readonly service: ImportPreviewService, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Post('mapping')
  @HttpCode(200)
  @UseGuards(MfaGuard)
  @UsePipes(VALIDATION)
  @RequireBrandPermission('imports.write')
  @RequireMfa('imports.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'batchId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'imports.write')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOperation({ operationId: 'saveImportMapping', summary: 'Save an immutable import mapping revision and freeze its preview' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current mapping version; use 0 for the first revision.' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['fieldMappings','categoryMappings'], properties: {
    fieldMappings: { type: 'object', minProperties: 1, maxProperties: 80, additionalProperties: { type: 'string', maxLength: 128 } }, categoryMappings: { type: 'object', maxProperties: 200, additionalProperties: { type: 'string', maxLength: 96 } },
    fieldMask: { type: 'array', maxItems: 80, items: { type: 'string', maxLength: 128 } },
  } } })
  @ApiExtension('x-renivet-csrf-policy', 'W1 session validates x-csrf-token and allowlisted Origin; CSRF state is session-bound.')
  @ApiResponse({ status: 200, description: 'Mapping revision and immutable preview were saved.', schema: MAPPING_RECEIPT_SCHEMA })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission, MFA, or CSRF denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'The import batch is not available.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Mapping version or idempotency conflict.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'Mapping data or precondition is invalid.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 503, description: 'Import storage is unavailable.', schema: ERROR_SCHEMA })
  async saveMapping(@Param('batchId') batchId: string, @Body() body: SaveImportMappingDto, @Req() request: ImportPreviewRequest,
    @Headers('idempotency-key') key?: string, @Headers('if-match') ifMatch?: string) {
    if (!key || !/^[A-Za-z0-9._:-]{1,120}$/.test(key)) throw new UnprocessableEntityException({ code: 'IMPORT_IDEMPOTENCY_KEY_INVALID', message: 'A valid idempotency key is required.' });
    const token = readSessionToken(request.headers.cookie);
    if (!token) throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(request.headers, origins, this.sessions.expectedCsrf(token))) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    const access = request.brandAccess!;
    return this.service.saveMapping({ brandId: access.brandId, batchId, actorUserId: session.userId, idempotencyKey: key,
      expectedVersion: expectedVersion(ifMatch), mapping: body, requestId: requestId(request.id, `mapping:${batchId}`) });
  }

  @Get('preview')
  @RequireBrandPermission('imports.read')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'batchId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'imports.read')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOperation({ operationId: 'getCatalogImportPreview', summary: 'Retrieve the latest immutable import preview' })
  @ApiResponse({ status: 200, description: 'The frozen preview.', schema: PREVIEW_SCHEMA })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'The import is not readable by this brand principal.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'The import preview is not available.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'The preview target changed and must be refreshed.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 503, description: 'Import storage is unavailable.', schema: ERROR_SCHEMA })
  async getPreview(@Param('batchId') batchId: string, @Req() request: ImportPreviewRequest) {
    const access = request.brandAccess!;
    return this.service.getPreview({ brandId: access.brandId, batchId, userId: access.userId, requestId: requestId(request.id, `preview:${batchId}`) });
  }
}
